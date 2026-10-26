// The widget on http://localhost:5173 (vite) and the runner on http://127.0.0.1:5174: two origins, as in production.
import { spawn } from "node:child_process";

const procs = [
    spawn("node", ["scripts/runner-server.mjs", "5174"], { stdio: "inherit" }),
    spawn("pnpm", ["exec", "vite"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", stop));
