let input = '';
for await (const chunk of process.stdin) input += chunk;
const { payload } = JSON.parse(input);
console.log(JSON.stringify(payload, null, 2));
