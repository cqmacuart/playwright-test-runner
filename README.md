# Playwright Test Runner UI

A powerful local Windows application to explore, validate, and execute Playwright tests through an intuitive web-based user interface. This tool simplifies the management of complex test suites by providing real-time feedback and flexible execution modes.

---

## 🚀 Key Features

- **📂 Workspace Explorer:** Easily browse and select local directories containing your Playwright projects.
- **🔍 Automated Test Discovery:** Automatically identifies `.spec.ts` and `.test.ts` files within the selected workspace.
- **⚡ Flexible Execution Modes:**
  - **Sequential:** Run tests one after another—ideal for debugging and avoiding resource contention.
  - **Parallel:** Execute multiple tests concurrently with a configurable number of workers for maximum speed.
- **📡 Real-time Monitoring:** Live log streaming via Server-Sent Events (SSE) and instant status updates (Passed, Failed, Running, Queued).
- **🌍 Bilingual Support:** Native UI support for both **English** and **Spanish**.
- **🛠️ Integrated Utilities:** Built-in filename validation, log inspection, and the ability to stop individual or batch runs.

---

## 🛠️ Tech Stack

### Frontend (`/client`)
- **Framework:** Next.js 15 (App Router)
- **Library:** React 19
- **Styling:** Modern Vanilla CSS
- **Language:** TypeScript

### Backend (`/server`)
- **Framework:** NestJS 11
- **Engine:** Fastify (for high performance)
- **Execution:** Child-process orchestration for Playwright CLI
- **Language:** TypeScript

---

## 📋 Prerequisites

- **Node.js:** version 20 or higher.
- **Operating System:** Windows (optimized for local file system access).

---

## 📥 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd PlaywrightTestUi
   ```

2. **Run the setup script:**
   This will install all dependencies for both the client and server workspaces.
   ```bash
   setup.bat
   # OR
   npm run setup
   ```

---

## 🏃 Getting Started

To start both the frontend and backend in development mode:

```bash
start-runner.bat
# OR
npm run dev
```

The application will be available at:
- **Frontend:** [http://localhost:3000](http://localhost:3000)
- **Backend API:** [http://localhost:3001](http://localhost:3001)

---

## 📖 Usage Guide

1. **Select Workspace:** Enter the path to your Playwright repository or use the "Browse Folders" button to find it.
2. **Explore Tests:** The application will render a tree view of your project. Folders like `node_modules` and `.git` are automatically ignored.
3. **Configure Run:**
   - Select the tests you want to run using the checkboxes.
   - Choose between **Sequential** or **Parallel** mode.
   - If Parallel, set the number of **Workers**.
4. **Execute:** Click "Execute Batch" or the play button on individual files.
5. **Monitor:** Watch the live logs by clicking the clipboard icon (📋) next to any running test.

---

## 📁 Project Structure

```text
PlaywrightTestUi/
├── client/          # Next.js Frontend
│   ├── app/         # Main UI components and logic
│   └── lib/         # API clients and type definitions
├── server/          # NestJS Backend
│   ├── src/
│   │   ├── workspace/ # FS management and directory tree
│   │   ├── tests/     # Test file utilities
│   │   └── runs/      # Playwright execution and SSE
├── scripts/         # Build and preflight utilities
├── setup.bat        # One-click installation
└── start-runner.bat # One-click startup
```

---

## 🇪🇸 Resumen en Español

**Playwright Test Runner UI** es una herramienta local para Windows diseñada para facilitar la ejecución de pruebas Playwright.

- **Configuración rápida:** Usa `setup.bat` para instalar y `start-runner.bat` para iniciar.
- **Interfaz Intuitiva:** Explora tus carpetas de test, selecciona qué pruebas correr y visualiza los resultados en tiempo real.
- **Modos de ejecución:** Soporta ejecución secuencial y paralela con hilos configurables.
- **Logs en vivo:** Visualiza la salida de la consola de Playwright directamente en el navegador.

---

## 📄 License

This project is private and intended for local development use.
