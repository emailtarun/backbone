window.api.on("timer:tick", ({ label, secs }) => {
  document.getElementById("label").textContent = label === "Eyes" ? "Eye break in" : "Break in";
  document.getElementById("secs").textContent = Math.ceil(secs);
});
