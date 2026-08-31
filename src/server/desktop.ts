import { app, BrowserWindow, Menu, Notification, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { startServer } from "./index.js";
import { log } from "./log.js";

/**
 * The Electron main process — NateBot's actual desktop shell.
 *
 * This is what makes it an app rather than a borrowed browser window: its own
 * name in the menu bar, its own icon in the Dock, its own entry in the window
 * switcher, and ⌘Q quitting NateBot instead of somebody else's browser.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");

const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
  version: string;
};

// Must be set before `ready` or macOS shows "Electron" in the menu bar.
app.setName("NateBot");
app.setAppUserModelId("com.nateajmera.natebot");

// Electron's bundled Node still marks node:sqlite experimental. We have chosen
// it deliberately — it removes a native build step from a global install — and
// the notice is not something a user of a desktop app should ever be shown.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  log.debug(`${warning.name}: ${warning.message}`);
});

let server: Awaited<ReturnType<typeof startServer>> | null = null;
let mainWindow: BrowserWindow | null = null;

function iconPath(): string {
  return path.join(PACKAGE_ROOT, "assets", "icon.png");
}

/**
 * A deliberately small menu. Everything about a *bot* is configured by talking
 * to it, so this only carries what the OS genuinely expects to find here.
 */
function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: "NateBot",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(process.env.NATEBOT_DEBUG === "1"
          ? ([{ type: "separator" as const }, { role: "toggleDevTools" as const }] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ role: "front" as const }] : [{ role: "close" as const }])],
    },
    {
      role: "help",
      submenu: [
        {
          label: "OpenClaw on GitHub",
          click: () => void shell.openExternal("https://github.com/openclaw/openclaw"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url: string): BrowserWindow {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 540,
    title: "NateBot",
    // Painted before the page loads, so there is no white flash on a dark app.
    backgroundColor: "#181715",
    show: false,
    autoHideMenuBar: !isMac,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 18 },
        }
      : { icon: iconPath() }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Everything is served from our own loopback origin.
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Links out of the app belong in the user's real browser, not in a window
  // that is supposed to be NateBot.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  // `shell=desktop` lets the UI reserve room for the traffic lights without
  // guessing whether it is running in a window or a plain browser tab.
  void win.loadURL(`${url}?shell=desktop`);
  return win;
}

async function boot(): Promise<void> {
  buildMenu();

  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(iconPath()));
    } catch (err) {
      log.debug(`could not set dock icon: ${(err as Error).message}`);
    }
  }

  try {
    server = await startServer(pkg.version, {
      // A blocked bot is exactly the case where nobody is looking at the
      // window, so it has to reach out rather than wait to be noticed.
      onApproval: ({ title, body }) => {
        if (!Notification.isSupported()) return;
        const note = new Notification({ title, body, silent: false });
        note.on("click", () => {
          const win = BrowserWindow.getAllWindows()[0] ?? mainWindow;
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
        });
        note.show();
      },
    });
  } catch (err) {
    log.error(`NateBot could not start: ${(err as Error).message}`);
    app.quit();
    return;
  }

  mainWindow = createWindow(server.url);
  // Preflight streams into the window that is already on screen.
  void server.ready;
}

void app.whenReady().then(boot);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    mainWindow = createWindow(server.url);
  }
});

app.on("window-all-closed", () => {
  // Closing the window quits NateBot, the way a single-window app should.
  app.quit();
});

app.on("before-quit", () => {
  server?.shutdown();
});
