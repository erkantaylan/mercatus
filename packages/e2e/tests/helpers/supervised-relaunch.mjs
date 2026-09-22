/**
 * Run a command, and die when the process that used to own it dies.
 *
 * The problem it solves: `03-dedicated-outage.spec.ts` kills the Aspire-managed `platform`
 * process to make an outage, and relaunches it afterwards so the machine is left working. That
 * relaunched process is NOT Aspire-managed, so `aspire stop` reports success and walks away while
 * it keeps holding port 4001 -- and keeps answering `GET /health` with 200 although its Postgres
 * was destroyed with the AppHost. A control plane that health-checks green and 500s on every real
 * request is the worst possible thing for the next `aspire run` to find.
 *
 * So the relaunch goes through here instead: this wrapper spawns the real process and watches the
 * pid that owned it (DCP, passed in MERCATUS_WATCH_PID). When that pid is gone -- which is what
 * `aspire stop` does -- it terminates the child and exits. Nothing has to be cleaned up by hand
 * and there is no orphan to explain.
 *
 * Plain .mjs on purpose: it is spawned by `node <this file>` from a detached child, so it must
 * not need tsx, a loader or a build.
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write('supervised-relaunch: nothing to run\n');
  process.exit(2);
}

const watchPid = Number(process.env['MERCATUS_WATCH_PID'] ?? '0');

const child = spawn(command, args, { stdio: 'ignore' });
child.on('exit', (code) => {
  process.exit(code ?? 0);
});

/** `kill(pid, 0)` throws ESRCH when the process is gone and EPERM when it is someone else's. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

if (Number.isInteger(watchPid) && watchPid > 0) {
  const timer = setInterval(() => {
    if (alive(watchPid)) return;
    clearInterval(timer);
    child.kill('SIGTERM');
    // Do not hold the machine hostage to a process ignoring SIGTERM.
    setTimeout(() => {
      child.kill('SIGKILL');
      process.exit(0);
    }, 5000).unref();
  }, 1000);
}
