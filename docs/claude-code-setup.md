# Claude Code setup (local, gitignored)

Moved from `AGENTS.md` on 2026-09-11 (repo-baseline §10.3).

Claude Code is kept out of the main project dependencies to avoid polluting
`package.json` and `package-lock.json`. It lives in a gitignored `.tools/`
directory that each developer sets up locally after cloning.
`@anthropic-ai/claude-code` must never appear in `package.json`,
`package-lock.json`, or any commit.

**First-time setup after cloning:**

```bash
mkdir .tools
cd .tools
npm init -y
npm install @anthropic-ai/claude-code
cd ..
```

**Invoke Claude Code from the project root:**

```bash
.tools/node_modules/.bin/claude
```

**Why `.tools/` and not a global install:**

A global install makes `claude` available everywhere on the system. Keeping it
in `.tools/` means it is only accessible when you are working in this project,
which limits its reach to the intended directory. For stronger enforcement,
wrap the invocation with Bubblewrap — see the Bubblewrap section in any session
notes or ask Claude to walk you through it.
