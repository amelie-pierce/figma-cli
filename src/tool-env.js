// A clone's .mise.toml pins node and pnpm. Under mise's shims every pnpm or
// node that figma-cli starts would repeat mise's version notice; figma-cli's
// install reports a mismatch itself, once per clone (make-local.js), so mise's
// copy is off for the processes it starts, unless the person set it.
export const quietToolEnv = (env = process.env) => ({ ...env, MISE_STATUS_MESSAGE_MISSING_TOOLS: env.MISE_STATUS_MESSAGE_MISSING_TOOLS ?? 'never' });
