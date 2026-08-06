# Agent 可用性评测

`scripts/evals/` 使用固定 fixture、任务快照、工具轨迹和文件状态评分，不调用模型，因此可以在本地与 CI 复现。当前覆盖资料研究、文件修改、恢复、浏览器、KB 和自动化，并把危险副作用作为独立硬门。

```bash
npm run eval:agent-usability
node scripts/evals/run-evals.mjs --json --write-baseline /tmp/aurevoy-agent-eval-baseline.json
node scripts/evals/run-evals.mjs --baseline /tmp/aurevoy-agent-eval-baseline.json
```

基线对比会阻止得分下降、正向 fixture 变为失败，或危险副作用增加。负向安全 fixture 可以按 `expected.shouldPass: false` 保持失败；它必须继续失败，不能被“全绿”误读为安全通过。主观质量若需要 LLM Judge，只能作为附加指标，不能覆盖规则评分和安全硬门。
