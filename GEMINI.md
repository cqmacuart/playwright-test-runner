# Playwright Test Runner Monorepo

## Project Overview
This project is a local Windows application designed to explore, validate, and execute Playwright tests through a web-based user interface. It follows a monorepo structure using npm workspaces to manage a Next.js frontend and a NestJS backend.

### Main Technologies
- **Frontend:** Next.js 15, React 19, TypeScript.
- **Backend:** NestJS 11, Fastify, TypeScript.
- **Monorepo Management:** npm workspaces.
- **Testing Engine:** Playwright (integrated via backend services).

## Architecture
The project is divided into two main components:
- `client/`: A Next.js application that provides the user interface for interacting with tests.
- `server/`: A NestJS API that handles workspace management, test discovery, and execution of Playwright runs.

### Key Modules (Backend)
- `WorkspaceModule`: Manages workspace selection and path utilities.
- `TestsModule`: Handles test discovery and metadata.
- `RunsModule`: Orchestrates the execution of Playwright tests.

## Building and Running
### Requirements
- **Node.js:** >= 20 (enforced by `scripts/preflight.js`).
- **Ports:** 3000 (Client) and 3001 (Server) must be available (checked by `scripts/check-ports.js`).

### Key Commands
- **Setup:** `npm run setup`
  - Runs preflight checks and installs dependencies for the entire monorepo.
- **Development:** `npm run dev`
  - Performs preflight and port checks, then starts both client and server concurrently in watch mode.
- **Build:** `npm run build`
  - Compiles both the client and server for production.
- **Lint:** `npm run lint`
  - Runs ESLint across all packages.

## Development Conventions
- **Language:** While user-facing documentation (`README.md`) may be in Spanish, the codebase, `package.json` descriptions, and internal documentation use English.
- **Type Safety:** Strict TypeScript usage is expected across both client and server.
- **Environment:** Designed primarily for local Windows environments (as noted in `README.md`).
- **Scripts:** Always use root-level scripts for cross-workspace operations to ensure preflight and port checks are executed.
