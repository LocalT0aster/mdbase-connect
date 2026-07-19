const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#edf2f3",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.loadURL(process.env.MDBASE_CONNECT_PORTAL_URL);
});

app.on("window-all-closed", () => app.quit());
