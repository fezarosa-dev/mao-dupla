// ---- Executam dentro da aba do Instagram (sessão logada via cookies) ----
async function infoContagem() {
  const id = document.cookie.match(/ds_user_id=(\d+)/)?.[1];
  if (!id) throw new Error("Não logado no Instagram");
  const r = await fetch(`/api/v1/users/${id}/info/`, { credentials: "include", headers: { "X-IG-App-ID": "936619743392459" } });
  const u = (await r.json()).user;
  return { followers: u.follower_count, following: u.following_count };
}

async function pagina(tipo, max) {
  const id = document.cookie.match(/ds_user_id=(\d+)/)?.[1];
  if (!id) throw new Error("Não logado no Instagram");
  const r = await fetch(`/api/v1/friendships/${id}/${tipo}/?count=100${max ? "&max_id=" + max : ""}`, {
    credentials: "include",
    headers: { "X-IG-App-ID": "936619743392459" },
  });
  if (!r.ok) throw new Error(`${tipo}: HTTP ${r.status}`);
  const j = await r.json();
  return {
    users: j.users.map((u) => ({ pk: u.pk, username: u.username, name: u.full_name, pic: u.profile_pic_url, verified: !!u.is_verified })),
    next: j.next_max_id || "",
  };
}

// Situação atual da conta no Instagram (usada para conferir mudanças suspeitas). null = não deu para verificar.
async function statusRel(pk) {
  try {
    const r = await fetch(`/api/v1/friendships/show/${pk}/`, { credentials: "include", headers: { "X-IG-App-ID": "936619743392459" } });
    if (!r.ok) return null;
    const j = await r.json();
    return { following: !!j.following, followed_by: !!j.followed_by };
  } catch { return null; }
}

// acao: "follow" | "unfollow". Imita o site: ambos são mutations GraphQL (v1/friendships/create|destroy passaram a
// devolver HTML). Tokens vêm da página aberta agora; nada é guardado entre execuções.
// ponytail: doc_ids mudam quando o Instagram publica novo bundle; recapturar usePolarisFollow/UnfollowMutation se o erro voltar.
// executeScript serializa só esta função: tudo que ela usa precisa estar dentro dela.
async function chamarIG(pk, acao) {
  const MUTATION = {
    follow: { nome: "usePolarisFollowMutation", doc: "26508036048874888" },
    unfollow: { nome: "usePolarisUnfollowMutation", doc: "27789106940691111" },
  };
  const ck = (n) => document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)"))?.[1] || "";
  const html = document.documentElement.innerHTML;
  const tok = (nome) => html.match(new RegExp('"' + nome + '",\\[\\],\\{"token":"([^"]+)"'))?.[1] || "";
  const lsd = tok("LSD"), dtsg = tok("DTSGInitialData");
  if (!lsd || !dtsg) return { ok: false, msg: "Tokens do Instagram não encontrados na página; recarregue a aba do Instagram." };
  const { nome, doc } = MUTATION[acao];
  const body = new URLSearchParams({
    av: ck("ds_user_id"), __a: "1", __user: "0", fb_dtsg: dtsg, lsd,
    fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: nome,
    server_timestamps: "true", doc_id: doc,
    variables: JSON.stringify({ target_user_id: String(pk), container_module: "profile", nav_chain: "PolarisProfilePostsTabRoot:profilePage:1:via_cold_start" }),
  }).toString();
  const r = await fetch("/api/graphql", {
    method: "POST", credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded", "X-CSRFToken": ck("csrftoken"), "X-IG-App-ID": "936619743392459",
      "X-FB-LSD": lsd, "X-ASBD-ID": "129477", "X-FB-Friendly-Name": nome,
    },
    body,
  });
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t.replace(/^for \(;;\);/, "")); } catch {}
  // bloqueio por excesso de ações: parar na hora
  if (r.status === 429 || /feedback_required|rate_limit/i.test(t)) return { ok: false, bloqueio: true, msg: "Instagram limitou as ações da conta (feedback_required)." };
  const st = j.data && Object.values(j.data)[0];
  if (r.ok && st && !j.errors) {
    const f = st.friendship_status;
    return { ok: true, msg: "", pendente: acao === "follow" && !!f && f.following !== true && !!f.outgoing_request };
  }
  return { ok: false, msg: `graphql → HTTP ${r.status} ${t.trimStart().startsWith("<") ? "(resposta HTML)" : t.slice(0, 160)}` };
}

// ---- Interface ----
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const TABS = {
  following: { label: "Seguindo", g: "Listas" },
  followers: { label: "Seguidores" },
  naoSegue: { label: "Não me seguem de volta" },
  euNaoSigo: { label: "Eu não sigo de volta" },
  perdi: { label: "Deixaram de me seguir", g: "Mudanças" },
  ganhei: { label: "Novos seguidores" },
  segSaiu: { label: "Saíram do seguindo" },
  segNovo: { label: "Novos no seguindo" },
  deixei: { label: "Deixei de seguir" },
  fila: { label: "Fila de unfollow", fila: "unfollow", g: "Filas" },
  filaF: { label: "Fila de follow", fila: "follow" },
};
const st = {
  followers: [], following: [], tab: "naoSegue", page: 0, q: "", sel: new Set(), stop: false, busy: false, loading: false, pp: 24,
  lost: [], gained: [], unfollowed: [], segLost: [], segGained: [], time: null, msg: "", bloqueio: 0, animar: true,
  fila: { unfollow: [], follow: [] }, recent: [],
};
let rel = { seg: new Set(), sig: new Set() }; // quem me segue / quem eu sigo (atualizado a cada render)

// Corrige texto UTF-8 que chegou lido como Latin-1 ("JoÃ£o" -> "João"); se não for esse caso, devolve igual.
const fixEnc = (t) => {
  if (!/[Â-ô][\u0080-¿]/.test(t) || /[^\u0000-ÿ]/.test(t)) return t;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(t, (c) => c.charCodeAt(0))); }
  catch { return t; }
};

// Fotos: baixadas pela extensão (host_permissions ignora o bloqueio de hotlink) e exibidas via blob.
const fotos = new Map(); // pk -> Promise<blobURL|null>
let fotosAtivas = 0;
const fotosFila = [];
const proxima = () => {
  while (fotosAtivas < 6 && fotosFila.length) {
    const { u, ok } = fotosFila.shift();
    fotosAtivas++;
    fetch(u.pic, { referrerPolicy: "no-referrer" })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => ok(URL.createObjectURL(b)), () => ok(null))
      .finally(() => { fotosAtivas--; proxima(); });
  }
};
function carregarFoto(u, img) {
  if (!u.pic) return queueMicrotask(() => img.onerror()); // depois de entrar no DOM
  if (!fotos.has(u.pk)) fotos.set(u.pk, new Promise((ok) => { fotosFila.push({ u, ok }); proxima(); }));
  fotos.get(u.pk).then((url) => { img.src = url || u.pic; }); // sem blob, tenta o link direto
}

const KEY = "instanf"; // chave mantida do nome antigo para não perder dados já salvos
const salvar = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      followers: st.followers, following: st.following, lost: st.lost, gained: st.gained, time: st.time, pp: st.pp,
      unfollowed: st.unfollowed, segLost: st.segLost, segGained: st.segGained, fila: st.fila,
    }));
  } catch {} // ponytail: localStorage ~5MB; trocar por chrome.storage + unlimitedStorage se estourar
};
const restaurar = () => {
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}
  for (const f of Object.values(st.fila)) for (const it of f) if (it.status === "andamento") it.status = "pendente";
  try { st.bloqueio = +localStorage.getItem("instanf_bloqueio") || 0; } catch {}
};

async function runInIG(func, args = []) {
  const [tab] = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  if (!tab) throw new Error("Abra o instagram.com (logado) em outra aba");
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return result;
}

// ---- feedback: toast e diálogo ----
function toast(msg, tipo = "ok") {
  const t = document.createElement("div");
  t.className = "toast " + tipo;
  t.textContent = msg;
  $("toasts").append(t);
  setTimeout(() => t.classList.add("sai"), 4500);
  setTimeout(() => t.remove(), 4900);
}

function confirmar(titulo, msg, rotulo, perigo = true) {
  return new Promise((ok) => {
    $("dtit").textContent = titulo;
    $("dmsg").textContent = msg;
    $("dok").textContent = rotulo;
    $("dok").className = perigo ? "danger" : "primary";
    $("dlg").returnValue = "";
    $("dlg").onclose = () => ok($("dlg").returnValue === "ok");
    $("dlg").showModal();
  });
}

const bloqueado = () => st.bloqueio > Date.now();

// ---- listas e relações ----
function listas() {
  rel = { seg: new Set(st.followers.map((u) => u.pk)), sig: new Set(st.following.map((u) => u.pk)) };
  return {
    following: st.following,
    followers: st.followers,
    naoSegue: st.following.filter((u) => !rel.seg.has(u.pk)),
    euNaoSigo: st.followers.filter((u) => !rel.sig.has(u.pk)),
    perdi: st.lost,
    ganhei: st.gained,
    segSaiu: st.segLost,
    segNovo: st.segGained,
    deixei: st.unfollowed,
    fila: st.fila.unfollow,
    filaF: st.fila.follow,
  };
}

function visiveis() {
  const q = st.q.trim().toLowerCase();
  const l = listas()[st.tab];
  return q ? l.filter((u) => u.username.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q)) : l;
}

// Selo de verificado (formato de estrela de 8 pontas, azul como no Instagram).
function selo() {
  const s = document.createElement("span");
  s.className = "selo";
  s.title = "Verificado";
  s.innerHTML = `<svg viewBox="0 0 24 24" role="img" aria-label="Verificado"><g fill="currentColor"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><rect x="3.5" y="3.5" width="17" height="17" rx="4" transform="rotate(45 12 12)"/></g><path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M8 12.4l2.8 2.8 5.4-5.8"/></svg>`;
  return s;
}

function avatar(u) {
  const img = document.createElement("img");
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.width = img.height = 52;
  img.onerror = () => {
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = u.username[0];
    img.replaceWith(ph);
  };
  carregarFoto(u, img);
  return img;
}

const limpo = ({ em, ...u }) => u;
function enfileirar(tipo, users) {
  const f = st.fila[tipo];
  for (const u of users) if (!f.some((x) => x.u.pk === u.pk)) f.push({ u: limpo(u), status: "pendente", msg: "" });
  salvar();
}

// ---- ação (usada pela fila e pelos botões manuais) ----
async function executar(acao, u) {
  const r = await runInIG(chamarIG, [u.pk, acao]);
  if (r.ok) {
    st.recent.push(Date.now());
    if (acao === "unfollow") {
      st.following = st.following.filter((x) => x.pk !== u.pk);
      st.unfollowed = [{ ...limpo(u), em: Date.now() }, ...st.unfollowed.filter((x) => x.pk !== u.pk)];
    } else if (!r.pendente && !st.following.some((x) => x.pk === u.pk)) {
      st.following.unshift(limpo(u));
    }
    salvar();
  } else if (r.bloqueio) { // ponytail: 6h fixo; o Instagram não informa a duração real
    st.bloqueio = Date.now() + 6 * 3600e3;
    try { localStorage.setItem("instanf_bloqueio", st.bloqueio); } catch {}
  }
  return r;
}

async function manual(acao, u) {
  if (st.busy || st.loading) return toast("Aguarde a operação em andamento terminar.", "erro");
  if (bloqueado()) return toast("Instagram limitou a conta há pouco. Aguarde antes de agir de novo.", "erro");
  const n = st.recent.filter((t) => t > Date.now() - 10 * 60e3).length;
  const un = acao === "unfollow";
  const ok = await confirmar(
    "⚠️ Cuidado com o ritmo",
    `${un ? "Deixar de seguir" : "Seguir"} muitas contas em pouco tempo pode fazer o Instagram bloquear sua conta temporariamente.\n\n` +
      (n ? `Você já fez ${n} ação(ões) nos últimos 10 minutos.\n` : "") +
      `Para várias contas, use a fila (ela espera entre cada uma).\n\n${un ? "Deixar de seguir" : "Seguir"} @${u.username} agora?`,
    un ? "Deixar de seguir" : "Seguir", un
  );
  if (!ok) return;
  st.busy = true;
  try {
    const r = await executar(acao, u);
    if (r.ok) toast(un ? `Você deixou de seguir @${u.username}` : r.pendente ? `Solicitação enviada para @${u.username}` : `Agora você segue @${u.username}`);
    else toast(r.msg, "erro");
  } catch (e) { toast(e.message, "erro"); }
  st.busy = false;
  render();
}

// ---- render ----
function card(u, i) {
  const meSegue = rel.seg.has(u.pk), eu = rel.sig.has(u.pk);
  const naFila = (t) => st.fila[t].some((x) => x.u.pk === u.pk);
  const d = document.createElement("div");
  d.className = "user" + (st.sel.has(u.pk) ? " sel" : "");
  d.style.setProperty("--i", Math.min(i, 20));
  // mesmos botões em todos os cards; os que não se aplicam ficam cinza e desabilitados
  d.innerHTML = `<input type="checkbox" aria-label="Selecionar @${u.username}" ${st.sel.has(u.pk) ? "checked" : ""}>
    <div class="info"><a target="_blank"></a><small></small>
      <div class="rel">
        <span class="${eu ? "on" : ""}">${eu ? "Você segue" : "Você não segue"}</span>
        <span class="${meSegue ? "on" : ""}">${meSegue ? "Te segue" : "Não te segue"}</span>
      </div>
      <div class="acts">
        <button data-a="follow" class="small primary" ${eu ? "disabled" : ""}>Seguir</button>
        <button data-a="unfollow" class="small ghost-danger" ${eu ? "" : "disabled"}>Unfollow</button>
        <button data-f="follow" class="small soft" ${eu || naFila("follow") ? "disabled" : ""}>${naFila("follow") ? "Na fila" : "+ Fila follow"}</button>
        <button data-f="unfollow" class="small soft" ${!eu || naFila("unfollow") ? "disabled" : ""}>${naFila("unfollow") ? "Na fila" : "+ Fila unfollow"}</button>
      </div></div>`;
  d.querySelector(".info").before(avatar(u));
  const a = d.querySelector("a");
  a.href = `https://www.instagram.com/${u.username}/`;
  a.textContent = u.username;
  if (u.verified) a.append(selo());
  d.querySelector("small").textContent = fixEnc(u.name || "") + (u.em ? ` · ${new Date(u.em).toLocaleDateString("pt-BR")}` : "");
  d.querySelector("input").onchange = (e) => {
    e.target.checked ? st.sel.add(u.pk) : st.sel.delete(u.pk);
    render();
  };
  d.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => manual(b.dataset.a, u)));
  d.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => {
    enfileirar(b.dataset.f, [u]);
    toast(`@${u.username} na fila de ${b.dataset.f}`);
    render();
  }));
  return d;
}

function render() {
  const L = listas();
  let grupo = "";
  $("tabs").replaceChildren(
    ...Object.entries(TABS).flatMap(([k, t]) => {
      const els = [];
      if (t.g) { grupo = t.g; const h = document.createElement("div"); h.className = "grp"; h.textContent = grupo; els.push(h); }
      const b = document.createElement("button");
      b.className = "tab";
      if (k === st.tab) b.setAttribute("aria-current", "page");
      b.innerHTML = `<span>${t.label}</span><b>${L[k].length}</b>`;
      b.onclick = () => { st.tab = k; st.page = 0; st.sel.clear(); st.animar = true; render(); };
      els.push(b);
      return els;
    })
  );

  const f = TABS[st.tab].fila;
  $("lista").style.display = f ? "none" : "";
  $("fila").style.display = f ? "block" : "none";
  if (f) return renderFila(f);

  const lista = visiveis();
  const pages = Math.max(1, Math.ceil(lista.length / st.pp));
  st.page = Math.min(st.page, pages - 1);
  const fatia = lista.slice(st.page * st.pp, (st.page + 1) * st.pp);

  $("grid").classList.toggle("anim", st.animar);
  st.animar = false;
  $("grid").replaceChildren(...fatia.map(card));
  if (!fatia.length) {
    $("grid").innerHTML = `<div class="empty"></div>`;
    $("grid").firstChild.textContent = !st.time && !st.followers.length ? "Sem dados ainda. Clique em Carregar do Instagram."
      : st.q ? "Nenhuma conta corresponde à busca." : "Nenhuma conta nesta lista.";
  }

  $("pageinfo").textContent = `Página ${st.page + 1} de ${pages} · ${lista.length} contas`;
  $("prev").disabled = st.page === 0;
  $("next").disabled = st.page >= pages - 1;
  $("pp").value = st.pp;

  const sel = L[st.tab].filter((u) => st.sel.has(u.pk));
  const paraUn = sel.filter((u) => rel.sig.has(u.pk)), paraFo = sel.filter((u) => !rel.sig.has(u.pk));
  $("bulkU").hidden = !paraUn.length;
  $("bulkU").textContent = `Enviar ${paraUn.length} p/ fila de unfollow`;
  $("bulkF").hidden = !paraFo.length;
  $("bulkF").textContent = `Enviar ${paraFo.length} p/ fila de follow`;
}

// ---- carregar listas ----
async function carregar() {
  if (st.busy || st.loading) return;
  st.loading = true;
  $("load").disabled = true;
  $("lprog").style.display = "block";
  $("status").textContent = "Carregando… as listas aparecem conforme chegam (abas de comparação só ficam certas no fim).";
  let corrigidas = 0;
  const ant = { followers: st.followers, following: st.following, had: !!st.time, time: st.time };
  try {
    const total = await runInIG(infoContagem).catch(() => null);
    st.followers = []; st.following = []; st.sel.clear();
    for (const tipo of ["followers", "following"]) {
      const nome = tipo === "followers" ? "seguidores" : "seguindo";
      const bar = $("lprogbar");
      total?.[tipo] ? (bar.max = total[tipo]) : bar.removeAttribute("max");
      let max = "";
      do {
        const r = await runInIG(pagina, [tipo, max]);
        st[tipo].push(...r.users);
        max = r.next;
        bar.value = st[tipo].length;
        $("lprogtxt").textContent = `Carregando ${nome}: ${st[tipo].length}${total?.[tipo] ? " / " + total[tipo] : ""}`;
        render();
        if (max) await sleep(800); // evita rate limit
      } while (max);
    }
    if (ant.had) { // compara com o snapshot anterior
      const antes = new Set(ant.followers.map((u) => u.pk)), agora = new Set(st.followers.map((u) => u.pk));
      st.lost = ant.followers.filter((u) => !agora.has(u.pk));
      st.gained = st.followers.filter((u) => !antes.has(u.pk));
      const sAntes = new Set(ant.following.map((u) => u.pk)), sAgora = new Set(st.following.map((u) => u.pk));
      st.segLost = ant.following.filter((u) => !sAgora.has(u.pk));
      st.segGained = st.following.filter((u) => !sAntes.has(u.pk));
      // A lista do Instagram às vezes omite contas: confere cada "saiu" direto antes de acusar.
      const duvida = [...new Map([...st.segLost, ...st.lost].map((u) => [u.pk, u])).values()].slice(0, 60);
      for (let i = 0; i < duvida.length; i++) {
        const u = duvida[i];
        $("lprogbar").max = duvida.length; $("lprogbar").value = i + 1;
        $("lprogtxt").textContent = `Conferindo alterações suspeitas: ${i + 1}/${duvida.length}`;
        const r = await runInIG(statusRel, [u.pk]).catch(() => null);
        if (r?.following && st.segLost.some((x) => x.pk === u.pk)) {
          st.segLost = st.segLost.filter((x) => x.pk !== u.pk); st.following.push(limpo(u)); corrigidas++;
        }
        if (r?.followed_by && st.lost.some((x) => x.pk === u.pk)) {
          st.lost = st.lost.filter((x) => x.pk !== u.pk); st.followers.push(limpo(u)); corrigidas++;
        }
        await sleep(500);
      }
    }
    st.time = Date.now();
    salvar();
    $("status").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR")}.` + (ant.had ? ` Comparado com ${new Date(ant.time).toLocaleString("pt-BR")}.` : "") + (corrigidas ? ` ${corrigidas} falso(s) alerta(s) corrigido(s) ao conferir.` : "");
  } catch (e) {
    $("status").textContent = "Erro: " + e.message + " — dados parciais não foram salvos.";
  }
  st.loading = false;
  $("load").disabled = false;
  $("lprog").style.display = "none";
  render();
}

// ---- filas ----
function renderFila(tipo) {
  const un = tipo === "unfollow";
  const fila = st.fila[tipo];
  const n = (s) => fila.filter((x) => x.status === s).length;
  $("ftitle").textContent = un ? "Fila de unfollow" : "Fila de follow";
  $("fstart").textContent = `Iniciar ${un ? "unfollow" : "follow"} (pausa de 15–30s)`;
  $("fbar").max = Math.max(1, fila.length);
  $("fbar").value = n("feito") + n("erro");
  const trava = bloqueado();
  if (!st.busy) {
    $("fstatus").textContent = trava
      ? `Instagram limitou a conta. Aguarde até ${new Date(st.bloqueio).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} antes de continuar — insistir piora o bloqueio.`
      : fila.length
        ? `${n("feito")} feito(s) · ${n("pendente")} pendente(s) · ${n("erro")} com erro${st.msg ? " — " + st.msg : ""}`
        : "Fila vazia. Selecione contas (ou use \"+ Fila\") para adicioná-las aqui.";
  }
  $("fstart").disabled = trava || st.busy || st.loading || !(n("pendente") + n("erro"));
  $("fstop").disabled = !st.busy;
  $("fclear").disabled = $("fempty").disabled = st.busy;
  $("flist").replaceChildren(
    ...fila.map((it) => {
      const d = document.createElement("div");
      d.className = "item";
      d.innerHTML = `<div class="info"><a target="_blank"></a><small></small></div><span class="badge ${it.status}"></span>`;
      d.querySelector(".info").before(avatar(it.u));
      const a = d.querySelector("a");
      a.href = `https://www.instagram.com/${it.u.username}/`;
      a.textContent = it.u.username;
      if (it.u.verified) a.append(selo());
      d.querySelector("small").textContent = it.status === "erro" ? it.msg : fixEnc(it.u.name || "");
      d.querySelector(".badge").textContent = { pendente: "Aguardando", andamento: "Em andamento…", feito: "Feito ✓", erro: "Erro" }[it.status];
      if (it.status === "pendente" && !st.busy) {
        const x = document.createElement("button");
        x.className = "small";
        x.textContent = "Remover";
        x.onclick = () => { st.fila[tipo] = st.fila[tipo].filter((y) => y !== it); salvar(); render(); };
        d.append(x);
      }
      return d;
    })
  );
}

async function espera(seg) {
  for (let i = seg; i > 0 && !st.stop; i--) {
    $("fstatus").textContent = `Próxima ação em ${i}s…`;
    await sleep(1000);
  }
}

async function rodarFila() {
  const tipo = TABS[st.tab].fila;
  if (!tipo || st.busy || st.loading) return;
  const pend = st.fila[tipo].filter((x) => x.status === "pendente" || x.status === "erro");
  if (!pend.length) return;
  const un = tipo === "unfollow";
  if (!await confirmar(
    "Iniciar fila",
    `${un ? "Deixar de seguir" : "Seguir"} ${pend.length} conta(s), com pausa aleatória de 15–30s entre cada uma?\n\nO Instagram pode bloquear contas com muitas ações em pouco tempo; recomendado no máximo ~100 por dia.`,
    "Iniciar", un
  )) return;
  st.busy = true; st.stop = false; st.msg = "";
  for (const it of pend) {
    if (st.stop) break;
    it.status = "andamento"; it.msg = "";
    $("fstatus").textContent = `${un ? "Unfollow" : "Follow"} @${it.u.username}…`;
    render();
    try {
      const r = await executar(tipo, it.u);
      if (!r.ok) throw new Error(r.msg);
      it.status = "feito";
    } catch (e) {
      it.status = "erro"; it.msg = e.message;
      st.msg = "interrompido por erro (veja o motivo no item)";
      break;
    }
    salvar();
    render();
    if (it !== pend[pend.length - 1]) await espera(Math.round(15 + Math.random() * 15)); // 15–30s aleatório
  }
  for (const it of pend) if (it.status === "andamento") it.status = "pendente";
  if (st.stop) st.msg = "parado por você";
  st.busy = false;
  salvar();
  render();
}

// ---- eventos ----
const irPara = () => { st.animar = true; render(); };
$("load").onclick = carregar;
$("pp").onchange = (e) => { // mantém o 1º item visível na nova paginação
  const primeiro = st.page * st.pp;
  st.pp = +e.target.value;
  st.page = Math.floor(primeiro / st.pp);
  salvar(); irPara();
};
$("q").oninput = (e) => { st.q = e.target.value; st.page = 0; irPara(); };
$("prev").onclick = () => { st.page--; irPara(); };
$("next").onclick = () => { st.page++; irPara(); };
$("selpage").onclick = () => {
  visiveis().slice(st.page * st.pp, (st.page + 1) * st.pp).forEach((u) => st.sel.add(u.pk));
  render();
};
$("selnone").onclick = () => { st.sel.clear(); render(); };
const enviarSelecionados = (tipo) => {
  const sel = listas()[st.tab].filter((u) => st.sel.has(u.pk) && rel.sig.has(u.pk) === (tipo === "unfollow"));
  enfileirar(tipo, sel);
  st.sel.clear();
  st.tab = tipo === "unfollow" ? "fila" : "filaF";
  irPara();
};
$("bulkU").onclick = () => enviarSelecionados("unfollow");
$("bulkF").onclick = () => enviarSelecionados("follow");
$("fstart").onclick = rodarFila;
$("fstop").onclick = () => { st.stop = true; };
$("fclear").onclick = () => { const t = TABS[st.tab].fila; st.fila[t] = st.fila[t].filter((x) => x.status !== "feito"); salvar(); render(); };
$("fempty").onclick = () => { st.fila[TABS[st.tab].fila] = []; st.msg = ""; salvar(); render(); };

// ---- exportar / importar zip ----
// ZIP-BEGIN
const crcTab = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = ~0; for (const x of b) c = crcTab[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };

// Zip sem compressão (método 0): {nome: texto} -> Uint8Array. ponytail: sem deflate; os dados são poucos MB.
function zip(files) {
  const enc = new TextEncoder(), partes = [], dir = [];
  let off = 0;
  for (const [nome, texto] of Object.entries(files)) {
    const n = enc.encode(nome), d = enc.encode(texto), crc = crc32(d);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // 0x0800 = nomes em UTF-8
    lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, n.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true);
    ch.setUint16(28, n.length, true); ch.setUint32(42, off, true);
    partes.push(new Uint8Array(lh.buffer), n, d);
    dir.push(new Uint8Array(ch.buffer), n);
    off += 30 + n.length + d.length;
  }
  const tamDir = dir.reduce((a, x) => a + x.length, 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, Object.keys(files).length, true); fim.setUint16(10, Object.keys(files).length, true);
  fim.setUint32(12, tamDir, true); fim.setUint32(16, off, true);
  const out = new Uint8Array(off + tamDir + 22);
  let o = 0;
  for (const x of [...partes, ...dir, new Uint8Array(fim.buffer)]) { out.set(x, o); o += x.length; }
  return out;
}

// Lê um zip (método 0 ou deflate) e devolve {nome: Uint8Array}.
async function unzip(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("não é um arquivo zip");
  const total = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const dec = new TextDecoder(), out = {};
  for (let i = 0; i < total; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip corrompido");
    const metodo = v.getUint16(p + 10, true), tam = v.getUint32(p + 20, true);
    const nn = v.getUint16(p + 28, true), ne = v.getUint16(p + 30, true), nc = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const nome = dec.decode(u8.subarray(p + 46, p + 46 + nn));
    const ini = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    const dados = u8.subarray(ini, ini + tam);
    if (metodo === 0) out[nome] = dados;
    else if (metodo === 8) out[nome] = new Uint8Array(await new Response(new Blob([dados]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else throw new Error("compressão não suportada");
    p += 46 + nn + ne + nc;
  }
  return out;
}
// ZIP-END

const csvCel = (v) => {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita fórmula ao abrir no Excel
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const csv = (lista) =>
  "\ufeff" + ["usuario,nome,id,verificado,voce_segue,te_segue,data", ...lista.map((u) =>
    [u.username, fixEnc(u.name || ""), u.pk, u.verified ? "sim" : "não", rel.sig.has(u.pk) ? "sim" : "não", rel.seg.has(u.pk) ? "sim" : "não", u.em ? new Date(u.em).toISOString() : ""].map(csvCel).join(",")
  )].join("\r\n");

const CAMPOS = ["followers", "following", "lost", "gained", "unfollowed", "segLost", "segGained"];

function exportarZip() {
  const L = listas();
  const arquivos = {
    "dados.json": JSON.stringify({ versao: 1, exportadoEm: new Date().toISOString(), time: st.time, pp: st.pp, fila: st.fila, ...Object.fromEntries(CAMPOS.map((c) => [c, st[c]])) }),
  };
  const nomes = { following: "seguindo", followers: "seguidores", naoSegue: "nao-me-seguem-de-volta", euNaoSigo: "eu-nao-sigo-de-volta", perdi: "deixaram-de-me-seguir", ganhei: "novos-seguidores", segSaiu: "sairam-do-seguindo", segNovo: "novos-no-seguindo", deixei: "deixei-de-seguir" };
  for (const [k, n] of Object.entries(nomes)) arquivos[`${n}.csv`] = csv(L[k]);
  arquivos["fila-unfollow.csv"] = csv(st.fila.unfollow.map((x) => x.u));
  arquivos["fila-follow.csv"] = csv(st.fila.follow.map((x) => x.u));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([zip(arquivos)], { type: "application/zip" }));
  a.download = `mao-dupla-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Zip exportado.");
}

// Aceita só o formato esperado; foto só de CDN do Instagram.
const fotoSegura = (url) => { try { const h = new URL(url).hostname; return /(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(h) ? url : ""; } catch { return ""; } };
const limparUser = (u) => (u && u.pk != null && typeof u.username === "string")
  ? { pk: String(u.pk), username: u.username, name: String(u.name ?? ""), pic: fotoSegura(u.pic), ...(u.verified === true ? { verified: true } : {}), ...(Number.isFinite(u.em) ? { em: u.em } : {}) }
  : null;
const limparLista = (l) => (Array.isArray(l) ? l.map(limparUser).filter(Boolean) : []);

async function importarZip(arquivo) {
  try {
    const f = await unzip(new Uint8Array(await arquivo.arrayBuffer()));
    if (!f["dados.json"]) throw new Error("dados.json não encontrado no zip");
    const d = JSON.parse(new TextDecoder().decode(f["dados.json"]));
    if (d.versao !== 1 || !Array.isArray(d.followers) || !Array.isArray(d.following)) throw new Error("formato desconhecido");
    if (!await confirmar("Importar dados", `Substituir os dados atuais pelos do arquivo (${d.followers.length} seguidores, ${d.following.length} seguindo, exportado em ${new Date(d.exportadoEm).toLocaleString("pt-BR")})?`, "Importar", false)) return;
    for (const c of CAMPOS) st[c] = limparLista(d[c]);
    st.fila = { unfollow: [], follow: [] };
    for (const t of ["unfollow", "follow"])
      st.fila[t] = (d.fila?.[t] || []).map((x) => ({ u: limparUser(x.u), status: ["feito", "erro"].includes(x.status) ? x.status : "pendente", msg: String(x.msg ?? "") })).filter((x) => x.u);
    st.time = Number.isFinite(d.time) ? d.time : null;
    if ([12, 24, 48, 96].includes(d.pp)) st.pp = d.pp;
    st.sel.clear(); st.page = 0; st.animar = true;
    salvar();
    $("status").textContent = `Dados importados (de ${st.time ? new Date(st.time).toLocaleString("pt-BR") : "data desconhecida"}).`;
    render();
    toast("Importação concluída.");
  } catch (e) { toast("Falha ao importar: " + e.message, "erro"); }
}

$("exp").onclick = exportarZip;
$("imp").onclick = () => $("file").click();
$("file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importarZip(f); };

restaurar();
if (st.time) $("status").textContent = `Dados salvos de ${new Date(st.time).toLocaleString("pt-BR")}. Clique em carregar para atualizar.`;
render();
