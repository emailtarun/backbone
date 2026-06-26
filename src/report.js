const note = document.getElementById("note");
document.getElementById("cancel").addEventListener("click", () => window.api.send("window:close"));
document.getElementById("send").addEventListener("click", () => {
  window.api.send("report:send", note.value.trim());
});
note.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") window.api.send("report:send", note.value.trim());
});
