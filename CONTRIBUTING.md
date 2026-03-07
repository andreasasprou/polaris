# Contributing to Polaris

Thank you for your interest in contributing!

## Setting Up the Project

**Prerequisites:** Node.js 18+ and [pnpm](https://pnpm.io/installation)

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/<your-username>/polaris.git
   cd polaris
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Start the development server:
   ```bash
   pnpm dev
   ```
   The app will be available at `http://localhost:3000`.

## Running Checks

Before submitting a PR, make sure all checks pass:

```bash
# Type checking
pnpm typecheck

# Linting
pnpm lint

# Format code
pnpm format
```

To verify the production build works:
```bash
pnpm build
```

## Submitting a Pull Request

1. Create a branch from `main` with a descriptive name:
   ```bash
   git checkout -b feat/my-feature
   # or
   git checkout -b fix/my-bug
   ```

2. Make your changes and commit them with a clear message:
   ```bash
   git commit -m "feat: add new feature"
   ```

3. Push your branch and open a PR against `main`:
   ```bash
   git push origin feat/my-feature
   ```

4. In your PR description, explain what the change does and why.

## Code Style

- All code is formatted with [Prettier](https://prettier.io/) — run `pnpm format` before committing.
- TypeScript is required; avoid using `any`.
- Follow the existing project structure: pages in `app/`, reusable components in `components/`, utilities in `lib/`.
