(async function(){
  const list = document.getElementById("list");
  const q = document.getElementById("q");

  const packaged = await fetch(chrome.runtime.getURL("data/ai_domains.json")).then(r=>r.json());
  const { customDomains = [] } = await new Promise(res => chrome.storage.local.get(["customDomains"], res));
  const domains = Array.from(new Set([...customDomains, ...packaged])).sort();

  function render(items) {
    list.innerHTML = items.map(d=>`<li>${d}</li>`).join("");
  }
  render(domains);

  q.oninput = ()=> {
    const s = q.value.toLowerCase();
    render(domains.filter(d => d.toLowerCase().includes(s)));
  };
})();
