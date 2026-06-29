const border = document.getElementById("border");
const hud = document.getElementById("hud");
const cue = document.getElementById("cue");
const cueText = document.getElementById("cueText");

window.api.on("flash:cmd", (cmd) => {
  if (cmd.type === "glow") {
    border.classList.toggle("on", !!cmd.on); // persistent until turned off
    border.classList.toggle("urgent", !!cmd.on && !!cmd.urgent); // faster flash after prolonged slouch
  } else if (cmd.type === "proximity") {
    hud.classList.toggle("on", !!cmd.on);
  } else if (cmd.type === "cue") {
    if (cmd.on && cmd.text) cueText.textContent = cmd.text;
    cue.classList.toggle("on", !!cmd.on);
  }
});
