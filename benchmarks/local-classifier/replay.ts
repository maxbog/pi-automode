// Extract exact classifier requests from pi-automode JSONL; never infer reference labels.
import {readFileSync, writeFileSync} from 'node:fs';
const [input,output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node --import tsx benchmarks/local-classifier/replay.ts INPUT.jsonl OUTPUT.json');
const records = readFileSync(input,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(r=>r.type==='classifier');
const cases=records.map((r,i)=>{
  const action=JSON.parse(r.prompt.action);
  return {id:`replay-${i}`,family:'real-replay',toolName:action.toolName,input:action.input,
    expected:null,rationale:'REQUIRES HUMAN LABEL: evaluate the exact saved policy and authorization.',
    replayPrompt:{system:r.prompt.system,context:r.prompt.context,action:r.prompt.action}};
});
writeFileSync(output,JSON.stringify(cases,null,2)+'\n');
console.error(`Exported ${cases.length} UNLABELED cases. Redact secrets locally; set expected and rationale manually before running. Do not commit private transcripts.`);
