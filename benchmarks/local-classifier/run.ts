import {readFileSync, writeFileSync, appendFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {hostname, platform, arch} from 'node:os';
import {localRegistry, benchmarkConfig, evaluate, summarize, type Case, type Row} from './lib.ts';

const {values} = parseArgs({options: {
  models: {type:'string', default:'benchmarks/local-classifier/configs/models.ollama.json'},
  model: {type:'string', default:'local-guard/qwen3.5:4b-mxfp8'},
  cases: {type:'string', default:'benchmarks/local-classifier/cases.json'},
  profile: {type:'string', default:'strict'}, reasoning: {type:'string', default:'off'},
  repeats: {type:'string', default:'3'}, warmups: {type:'string', default:'3'},
  seed: {type:'string', default:'20261008'}, out: {type:'string', default:'benchmarks/local-classifier/results/run'},
  pid: {type:'string'}, label: {type:'string', default:'unrecorded runtime/model build'},
  'allow-remote': {type:'boolean', default:false}, 'thinking-format': {type:'string', default:'ollama'}
}});
const profile = values.profile; const reasoning = values.reasoning;
if (!['stock','strict'].includes(profile!) || !['off','on','default'].includes(reasoning!)) throw new Error('Invalid profile/reasoning');
const count = (s: string | undefined, min: number) => {const n = Number(s); if (!Number.isSafeInteger(n)||n<min) throw new Error('Invalid count'); return n;};
const repeats = count(values.repeats,1); const warmups = count(values.warmups,0);
let seed = count(values.seed,0) >>> 0;
const modelsText = readFileSync(values.models!, 'utf8'); const models = JSON.parse(modelsText);
const slash = values.model!.indexOf('/'); const provider = values.model!.slice(0,slash); const id = values.model!.slice(slash+1);
const registered = models.providers?.[provider]?.models?.find((m:any)=>m.id===id);
if (!registered) throw new Error('Model is not in the supplied isolated models file');
const url = new URL(models.providers[provider].baseUrl);
if (!values['allow-remote'] && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Only loopback inference is allowed by default');
// Copy and pin transport toggles. No real user config or credentials are read.
if (reasoning !== 'default') {
  registered.reasoning = reasoning === 'on';
  const api = values['thinking-format'];
  if (!['ollama','chat-template'].includes(api!)) throw new Error('Invalid thinking format');
  registered.samplingParams = {...registered.samplingParams,
    ...(api==='ollama' ? {reasoning_effort: reasoning==='on'?'low':'none'}
      : {chat_template_kwargs: {enable_thinking: reasoning==='on'}})};
}
if (reasoning === 'default') {
  registered.reasoning = true;
  delete registered.samplingParams?.reasoning_effort;
  delete registered.samplingParams?.chat_template_kwargs;
}
const corpusText = readFileSync(values.cases!, 'utf8'); const cases: Case[] = JSON.parse(corpusText);
if (!cases.length || new Set(cases.map(c=>c.id)).size !== cases.length) throw new Error('Empty corpus or duplicate IDs');
for (const c of cases) if (!['allow','block'].includes(c.expected) || (c.strictExpected !== undefined && !['allow','block'].includes(c.strictExpected)) || !c.rationale) throw new Error(`Unlabeled case ${c.id}`);
const out = resolve(values.out!); mkdirSync(dirname(out), {recursive:true});
writeFileSync(out+'.jsonl','');
const {registry,close} = await localRegistry(models);
const config = benchmarkConfig(profile as any, values.model!, reasoning as any);
const sha = (s:string) => createHash('sha256').update(s).digest('hex');
const metadata = {date:new Date().toISOString(), hostname:hostname(), platform:platform(), arch:arch(), node:process.version,
  commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  piAi:JSON.parse(readFileSync('node_modules/@earendil-works/pi-ai/package.json','utf8')).version,
  model:values.model, label:values.label, profile, reasoning, repeats, warmups, seed:values.seed,
  corpusSha256:sha(corpusText), modelsSha256:sha(modelsText), effectiveModel:registry.find(provider,id), config,
  memoryNote:'RSS samples of the supplied server PID only; excludes child runners unless that PID is supplied. Not Metal allocation or whole-system unified memory.'};
let peakRssKiB: number | null = null;
const sample = () => {if (values.pid) {
  try {const n = Number(execFileSync('ps',['-o','rss=','-p',String(count(values.pid,1))],{encoding:'utf8'}).trim());
    if (n>0) peakRssKiB = Math.max(peakRssKiB??0,n); } catch {} }};
const timer = values.pid ? setInterval(sample,100) : undefined;
const rows: Row[] = [];
try {
  for (let i=0;i<warmups;i++) await evaluate(registry,config,cases[i%cases.length]!, 'benchmark');
  for (let repeat=0;repeat<repeats;repeat++) {
    const shuffled = [...cases];
    for (let i=shuffled.length-1;i>0;i--) {seed=(Math.imul(seed,1664525)+1013904223)>>>0; const j=seed%(i+1); [shuffled[i],shuffled[j]]=[shuffled[j]!,shuffled[i]!];}
    for (const item of shuffled) {
      const started = performance.now(); const result = await evaluate(registry,config,item,'benchmark');
      const row = {id:item.id,family:item.family,expected:profile==='strict'?(item.strictExpected??item.expected):item.expected,
        repeat, result,durationMs:performance.now()-started}; rows.push(row); sample();
      appendFileSync(out+'.jsonl',JSON.stringify(row)+'\n');
      process.stderr.write(`${rows.length}/${cases.length*repeats} ${item.id}: ${result.decision}\n`);
    }
  }
  const summary = {metadata, peakServerRssKiB:peakRssKiB, ...summarize(rows)};
  writeFileSync(out+'.summary.json',JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
  if (summary.falseApprovals || summary.invalidRequests || summary.requestErrors) process.exitCode=1;
} finally {if (timer) clearInterval(timer); close();}
