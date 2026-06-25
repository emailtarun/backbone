const border = document.getElementById("border");
const hud = document.getElementById("hud");
let flashTimer = null;

window.api.on("flash:cmd", (cmd) => {
  if (cmd.type === "flash") {
    border.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => border.classList.remove("on"), 700);
  } else if (cmd.type === "proximity") {
    hud.classList.toggle("on", !!cmd.on);
  }
});
