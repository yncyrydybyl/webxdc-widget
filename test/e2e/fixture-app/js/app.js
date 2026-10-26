const $ = (id) => document.getElementById(id);
$("me").textContent = `${webxdc.selfName} / ${webxdc.isAppSender ? "sender" : "receiver"} / ${webxdc.selfAddr.length}`;
localStorage.setItem("opened", "yes");
$("storage").textContent = `ls keys: ${Object.keys(localStorage).join(",")}`;
webxdc
    .setUpdateListener((u) => {
        const li = document.createElement("li");
        li.textContent = `${u.serial}/${u.max_serial}: ${JSON.stringify(u.payload)}`;
        $("log").appendChild(li);
    }, 0)
    .then(() => (document.body.dataset.listening = "1"));
$("send").onclick = () => webxdc.sendUpdate({ payload: { by: webxdc.selfName }, summary: "1 click", info: "someone clicked" }, "");
$("net").onclick = async () => {
    try {
        await fetch("https://example.org/leak?x=1", { mode: "no-cors" });
        $("netout").textContent = "fetch LEAKED";
    } catch {
        $("netout").textContent = "fetch blocked";
    }
};
$("img").onclick = () => {
    const i = new Image();
    i.onload = () => ($("netout").textContent = "image LEAKED");
    i.onerror = () => ($("netout").textContent = "image blocked");
    i.src = "https://example.org/x.png";
};
$("nav").onclick = () => {
    location.href = "https://example.org/";
};
