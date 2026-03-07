# Contributing

Thank you for your interest in contributing to this project!

## Prerequisites

- [Node.js](https://nodejs.org/) (see `.nvmrc` or `package.json` for the required version)
- [pnpm](https://pnpm.io/)

## Getting Started

1. Fork the repository and clone your fork.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Start the development server:
   ```bash
   pnpm dev
   ```

## Development Workflow

- **Lint:** `pnpm lint`
- **Format:** `pnpm format`
- **Type check:** `pnpm typecheck`
- **Build:** `pnpm build`

Run these checks before submitting a pull request to ensure your changes pass CI.

## Adding UI Components

This project uses [shadcn/ui](https://ui.shadcn.com/). To add a new component:

```bash
npx shadcn@latest add <component-name>
```

Components are placed in the `components/` directory.

## Pull Requests

1. Create a branch from `main` with a descriptive name (e.g., `feat/add-button`, `fix/layout-overflow`).
2. Keep changes focused — one feature or fix per PR.
3. Ensure all checks pass (`lint`, `typecheck`, `build`) before opening a PR.
4. Write a clear PR description explaining what changed and why.

## Code Style

- TypeScript is required — avoid `any` where possible.
- Formatting is enforced with [Prettier](https://prettier.io/). Run `pnpm format` before committing.
- Follow the existing file and component structure.

## Reporting Issues

Please open a GitHub issue with a clear description, steps to reproduce, and any relevant context or screenshots.
