// A checker must be read-only and write exactly one JSON result to stdout.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { event } = JSON.parse(input);
const supplied = typeof event.input?.payload?.ticket === 'string' && event.input.payload.ticket.trim().length > 0;
console.log(JSON.stringify({ status: supplied ? 'pass' : 'fail', reason: supplied ? 'Ticket supplied' : 'Provide payload.ticket' }));
