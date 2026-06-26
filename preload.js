const { contextBridge, ipcRenderer } = require("electron");

const sendChannels = [
  "posture:update", "monitor:ready", "monitor:error", "monitor:calibrated",
  "overlay:done", "overlay:postpone", "window:close", "break:test", "watch:test",
  "setup:setMonitoring", "setup:calibrate", "setup:done", "setup:showCamera",
  "cameras:list",
];
const onChannels = [
  "monitor:config", "monitor:setPaused", "monitor:calibrate",
  "sound:play", "flash:cmd", "overlay:show", "timer:tick",
  "setup:posture", "setup:calibrated", "setup:cameraError", "watch:testResult", "cameras:list", "monitor:baseline",
];
const invokeChannels = [
  "settings:get", "settings:set", "stats:get", "cameras:get",
  "stretch:library", "stretch:toggle", "stretch:reset",
];

contextBridge.exposeInMainWorld("api", {
  send(channel, data) {
    if (sendChannels.includes(channel)) ipcRenderer.send(channel, data);
  },
  on(channel, cb) {
    if (onChannels.includes(channel)) {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  },
  invoke(channel, data) {
    if (invokeChannels.includes(channel)) return ipcRenderer.invoke(channel, data);
    return Promise.reject(new Error("channel not allowed: " + channel));
  },
});
