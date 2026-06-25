const { contextBridge, ipcRenderer } = require("electron");

const sendChannels = [
  "posture:update", "monitor:ready", "monitor:error", "monitor:calibrated",
  "overlay:done", "overlay:postpone", "window:close", "break:test", "watch:test",
];
const onChannels = [
  "monitor:config", "monitor:setPaused", "monitor:calibrate",
  "sound:play", "flash:cmd", "overlay:show", "timer:tick",
];
const invokeChannels = [
  "settings:get", "settings:set", "settings:resetExercises", "stats:get",
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
