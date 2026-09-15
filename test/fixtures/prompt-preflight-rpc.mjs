// Protocol fixture: receipt is independent of caller lifetime and model completion.
let buffer = '', modelTimer;
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const response = (event, success = true) => send({ type: 'response', id: event.id, command: event.type, success, error: success ? undefined : 'preflight rejected' });
function handle(event) {
  if (event.type === 'prompt') {
    send({ type: 'preflight', id: event.id });
    if (event.receiptDelay !== undefined) setTimeout(() => {
      // A command mismatch must not settle this prompt's acceptance ledger.
      if (event.wrongCommand) {
        send({ type: 'response', id: event.id, command: 'get_state', success: true });
        return;
      }
      send({ type: 'receipt', id: event.id });
      response(event, event.accepted !== false);
      if (event.accepted !== false) modelTimer = setTimeout(() => send({ type: 'model_complete' }), 10000);
    }, event.receiptDelay);
    return;
  }
  if (event.type === 'abort' || event.type === 'clear_queue') send({ type: 'cleanup_command', command: event.type });
  if (event.type === 'abort') clearTimeout(modelTimer);
  response(event);
}
process.stdin.on('data', data => {
  buffer += data;
  let n;
  while ((n = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => { send({ type: 'eof' }); process.exit(0); });
process.on('SIGTERM', () => { send({ type: 'signal_received' }); process.exit(0); });
