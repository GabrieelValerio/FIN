import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
         createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile,
         EmailAuthProvider, reauthenticateWithCredential, updatePassword }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, writeBatch,
         updateDoc, setDoc, addDoc, deleteDoc, orderBy, limit, onSnapshot, deleteField, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDSnXlTpkap7K6-LcNQStjZDpzSCKjuaLU",
  authDomain: "sistema-fin-5d81e.firebaseapp.com",
  projectId: "sistema-fin-5d81e",
  storageBucket: "sistema-fin-5d81e.firebasestorage.app",
  messagingSenderId: "586657265245",
  appId: "1:586657265245:web:926b69db2778f86fb77fb4"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ---------- Login ----------
export const entrar = () => signInWithPopup(auth, new GoogleAuthProvider());
export const sair = () => signOut(auth);

export async function cadastrarEmail(email, senha, nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite um nome de usuário.");
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), senha);
  await updateProfile(cred.user, { displayName: nome });
}
export const entrarEmail = (email, senha) => signInWithEmailAndPassword(auth, email.trim(), senha);
export const recuperarSenha = (email) => sendPasswordResetEmail(auth, email.trim());
export const aoMudarLogin = (fn) => onAuthStateChanged(auth, fn);

// ---------- Campanha ----------
function gerarCodigo() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let codigo = "";
  for (let k = 0; k < 8; k++) {
    codigo += letras[Math.floor(Math.random() * letras.length)];
  }
  return codigo;
}

export async function criarCampanha(nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite o nome da campanha.");
  const uid = auth.currentUser.uid;
  const campRef = doc(collection(db, "campanhas"));
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo();
    const batch = writeBatch(db);
    batch.set(campRef, { nome, mestreUid: uid, codigo, ativa: true, criadaEm: serverTimestamp() });
    batch.set(doc(db, "convites", codigo), { campanhaId: campRef.id, mestreUid: uid, nome });
    try {
      await batch.commit();
      return codigo;
    } catch (e) {
      if (tentativa === 4) throw e;
    }
  }
}

export async function minhasCampanhas() {
  const q = query(collection(db, "campanhas"), where("mestreUid", "==", auth.currentUser.uid));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getCampanha(id) {
  const s = await getDoc(doc(db, "campanhas", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

// Painel do mestre: escuta só os documentos "vivo" (pequenos) da campanha
export function escutarCampanha(campId, fn, aoErro) {
  const q = query(collection(db, "vivo"),
    where("mestreUid", "==", auth.currentUser.uid),
    where("campanhaId", "==", campId));
  return onSnapshot(q, (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), aoErro);
}

// ---------- Personagem ----------
export async function criarPersonagem(nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite o nome do personagem.");
  const ref = doc(collection(db, "personagens"));
  const base = { donoUid: auth.currentUser.uid, donoNome: auth.currentUser.displayName || auth.currentUser.email || "",
                  campanhaId: null, mestreUid: null, nome };
  const batch = writeBatch(db);
  batch.set(ref, { ...base, criadoEm: serverTimestamp(), ficha: {} });
  batch.set(doc(db, "vivo", ref.id), {
    ...base,
    pv: { atual: 0, total: 0, temp: 0 },
    pc: { atual: 0, total: 0 },
    pe: { atual: 0, total: 0 },
    ps: { atual: 0, total: 0 },
    cb: { atual: 0, total: 0 },
    estados: []
  });
  await batch.commit();
  return ref.id;
}

export async function meusPersonagens() {
  const q = query(collection(db, "personagens"), where("donoUid", "==", auth.currentUser.uid));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getPersonagem(id) {
  const s = await getDoc(doc(db, "personagens", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export async function getVivo(id) {
  const s = await getDoc(doc(db, "vivo", id));
  return s.exists() ? s.data() : {};
}

export const escutarVivo = (persId, fn, aoErro) =>
  onSnapshot(doc(db, "vivo", persId), (s) => { if (s.exists()) fn(s.data()); }, aoErro);

export async function vincularPersonagem(persId, codigo) {
  const convite = await getDoc(doc(db, "convites", codigo.trim().toUpperCase()));
  if (!convite.exists()) throw new Error("Código de convite não encontrado.");
  const { campanhaId, mestreUid, nome } = convite.data();
  const batch = writeBatch(db);
  batch.update(doc(db, "personagens", persId), { campanhaId, mestreUid });
  batch.update(doc(db, "vivo", persId), { campanhaId, mestreUid });
  await batch.commit();
  return { campanhaId, nome };
}

// ---------- Ao vivo: junta as mudanças e grava 1,5 s depois do último clique ----------
const arenaDe = {}; // personagem -> arena em que está
const pendentes = {};
const timers = {};

export function salvarVivo(persId, campo, valor) {
  pendentes[persId] = pendentes[persId] || {};
  pendentes[persId][campo] = valor;
  clearTimeout(timers[persId]);
  timers[persId] = setTimeout(() => enviarVivo(persId), 1500);
}

export async function enviarVivo(persId) {
  const dados = pendentes[persId];
  if (!dados) return;
  delete pendentes[persId];
  const extra = { ...dados, atualizadoEm: serverTimestamp() };
  await updateDoc(doc(db, "vivo", persId), extra);
  // se o personagem está numa arena, espelha os pontos para quem está lá
  if (arenaDe[persId]) updateDoc(doc(db, "arenas", arenaDe[persId], "membros", persId), extra).catch(() => {});
}

// ---------- Ficha completa (botão Salvar) ----------
// pfTotal: número calculado (ou null se não há PF); pfExiste: se o vivo já tem o campo pf
export async function salvarFicha(persId, topo, ficha, pfTotal, pfExiste) {
  const batch = writeBatch(db);
  batch.update(doc(db, "personagens", persId), { ...topo, ficha, atualizadoEm: serverTimestamp() });
  const vivo = { nome: topo.nome, atualizadoEm: serverTimestamp() };
  if (pfTotal === null) { if (pfExiste) vivo.pf = deleteField(); }
  else if (!pfExiste) vivo.pf = { atual: pfTotal, total: pfTotal };
  else vivo["pf.total"] = pfTotal;
  batch.update(doc(db, "vivo", persId), vivo);
  await batch.commit();
}

// ---------- Renomear e apagar ----------
export async function renomearCampanha(campId, codigo, nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite um nome.");
  const batch = writeBatch(db);
  batch.update(doc(db, "campanhas", campId), { nome });
  batch.update(doc(db, "convites", codigo), { nome });
  await batch.commit();
}

export async function renomearPersonagem(persId, nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite um nome.");
  const batch = writeBatch(db);
  batch.update(doc(db, "personagens", persId), { nome });
  batch.update(doc(db, "vivo", persId), { nome });
  await batch.commit();
}

export async function apagarPersonagem(persId) {
  const cod = ((await getDoc(doc(db, "personagens", persId))).data() || {}).codigoVer;
  const batch = writeBatch(db);
  if (cod) batch.delete(doc(db, "codigosFicha", cod));
  batch.delete(doc(db, "personagens", persId, "midia", "imagens"));
  batch.delete(doc(db, "personagens", persId));
  batch.delete(doc(db, "vivo", persId));
  await batch.commit();
}

// Apaga a campanha e desvincula os personagens dela (eles continuam existindo)
export async function apagarCampanha(campId, codigo) {
  const q = query(collection(db, "vivo"),
    where("mestreUid", "==", auth.currentUser.uid),
    where("campanhaId", "==", campId));
  const ids = (await getDocs(q)).docs.map((d) => d.id);
  const batch = writeBatch(db);
  ids.forEach((id) => {
    batch.update(doc(db, "personagens", id), { campanhaId: null, mestreUid: null });
    batch.update(doc(db, "vivo", id), { campanhaId: null, mestreUid: null });
  });
  // as invocações (criaturas) da campanha também são apagadas
  const invs = await getDocs(query(collection(db, "invocacoes"),
    where("mestreUid", "==", auth.currentUser.uid), where("campanhaId", "==", campId)));
  invs.docs.forEach((d) => { batch.delete(d.ref); batch.delete(doc(db, "invVivo", d.id)); });
  batch.delete(doc(db, "convites", codigo));
  batch.delete(doc(db, "campanhas", campId));
  await batch.commit();
  return ids.length;
}

// ---------- Painel da campanha: lista só com nomes + quem está em sessão ----------
export async function listarCampanha(campId) {
  const q = query(collection(db, "vivo"),
    where("mestreUid", "==", auth.currentUser.uid),
    where("campanhaId", "==", campId));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, nome: d.data().nome, donoNome: d.data().donoNome || "", donoUid: d.data().donoUid }));
}

export const setSessao = (campId, ids) => updateDoc(doc(db, "campanhas", campId), { sessao: ids });

// Mantém o nome do dono (usuário) atualizado nos personagens dele
export async function sincronizarDono(lista) {
  const nome = auth.currentUser.displayName || auth.currentUser.email || "";
  const mudar = lista.filter((p) => p.donoNome !== nome);
  if (!mudar.length) return;
  const batch = writeBatch(db);
  mudar.forEach((p) => {
    batch.update(doc(db, "personagens", p.id), { donoNome: nome });
    batch.update(doc(db, "vivo", p.id), { donoNome: nome });
  });
  await batch.commit();
}

// ---------- Sair da campanha e nome de usuário ----------
export async function desvincularPersonagem(persId) {
  const batch = writeBatch(db);
  const solto = { campanhaId: null, mestreUid: null };
  batch.update(doc(db, "personagens", persId), solto);
  batch.update(doc(db, "vivo", persId), solto);
  await batch.commit();
}

export async function mudarNomeUsuario(nome) {
  nome = nome.trim();
  if (nome.length < 2 || nome.length > 30) throw new Error("O nome precisa ter de 2 a 30 caracteres.");
  await updateProfile(auth.currentUser, { displayName: nome });
}

// ---------- Senha ----------
export async function mudarSenha(atual, nova) {
  const u = auth.currentUser;
  if (!u.providerData.some((p) => p.providerId === "password"))
    throw new Error("Esta conta entra pelo Google e não tem senha aqui.");
  if (nova.length < 6) throw new Error("A nova senha precisa ter pelo menos 6 caracteres.");
  await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, atual));
  await updatePassword(u, nova);
}

// ---------- Usuários e administração ----------
export const registrarUsuario = () => setDoc(doc(db, "usuarios", auth.currentUser.uid), {
  nome: auth.currentUser.displayName || "", email: auth.currentUser.email || "", atualizadoEm: serverTimestamp()
}, { merge: true });

// Admin = quem tem um documento admins/{uid} (criado à mão no console, nunca pelo site)
export async function souAdmin() {
  try { return (await getDoc(doc(db, "admins", auth.currentUser.uid))).exists(); }
  catch (e) { return false; }
}

export async function adminCarregar() {
  const [u, c, p] = await Promise.all([
    getDocs(collection(db, "usuarios")), getDocs(collection(db, "campanhas")), getDocs(collection(db, "vivo"))]);
  const lista = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { usuarios: lista(u), campanhas: lista(c), personagens: lista(p) };
}

export async function adminRenomearCampanha(campId, codigo, nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite um nome.");
  const batch = writeBatch(db);
  batch.update(doc(db, "campanhas", campId), { nome });
  batch.update(doc(db, "convites", codigo), { nome });
  await batch.commit();
}

export async function adminApagarCampanha(campId, codigo, persIds) {
  const batch = writeBatch(db);
  persIds.forEach((id) => {
    batch.update(doc(db, "personagens", id), { campanhaId: null, mestreUid: null });
    batch.update(doc(db, "vivo", id), { campanhaId: null, mestreUid: null });
  });
  batch.delete(doc(db, "convites", codigo));
  batch.delete(doc(db, "campanhas", campId));
  await batch.commit();
}

export const adminRenomearPersonagem = renomearPersonagem;
export const adminApagarPersonagem = apagarPersonagem;

// ---------- Imagens do personagem (normal e ferido), guardadas reduzidas no Firestore ----------
const refImagens = (persId) => doc(db, "personagens", persId, "midia", "imagens");

export async function getImagens(persId) {
  const s = await getDoc(refImagens(persId));
  return s.exists() ? s.data() : {};
}
export const salvarImagem = (persId, qual, dataUrl) =>
  setDoc(refImagens(persId), { [qual]: dataUrl, atualizadoEm: serverTimestamp() }, { merge: true });
export const removerImagem = (persId, qual) =>
  updateDoc(refImagens(persId), { [qual]: deleteField(), atualizadoEm: serverTimestamp() });

// ---------- Código do personagem: ver a ficha em modo leitura ----------
export async function gerarCodigoFicha(persId, antigo) {
  const uid = auth.currentUser.uid;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo();
    const batch = writeBatch(db);
    batch.set(doc(db, "codigosFicha", codigo), { persId, donoUid: uid });
    if (antigo) batch.delete(doc(db, "codigosFicha", antigo));
    batch.update(doc(db, "personagens", persId), { codigoVer: codigo, compartilhado: true });
    batch.update(doc(db, "vivo", persId), { compartilhado: true, compartVersao: Date.now() });
    try {
      await batch.commit();
      return codigo;
    } catch (e) {
      if (tentativa === 4) throw e;
    }
  }
}

export async function desativarCodigoFicha(persId, codigo) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "codigosFicha", codigo));
  batch.update(doc(db, "personagens", persId), { codigoVer: null, compartilhado: false });
  batch.update(doc(db, "vivo", persId), { compartilhado: false, compartVersao: Date.now() });
  await batch.commit();
}

export async function buscarFichaPorCodigo(codigo) {
  const s = await getDoc(doc(db, "codigosFicha", codigo.trim().toUpperCase()));
  if (!s.exists()) throw new Error("Código não encontrado.");
  return s.data().persId;
}

// ---------- Termos de uso e atualizações ----------
export const TERMOS_VERSAO = 1; // aumente este número se mudar os termos: todos aceitam de novo

export async function perfilUsuario() {
  const s = await getDoc(doc(db, "usuarios", auth.currentUser.uid));
  return s.exists() ? s.data() : {};
}
export const aceitarTermos = () => setDoc(doc(db, "usuarios", auth.currentUser.uid),
  { termosVersao: TERMOS_VERSAO, termosEm: serverTimestamp() }, { merge: true });
export const marcarAtualizacaoVista = (id) => setDoc(doc(db, "usuarios", auth.currentUser.uid),
  { atualizacaoVista: id }, { merge: true });

export async function ultimasAtualizacoes(n) {
  const q = query(collection(db, "atualizacoes"), orderBy("criadoEm", "desc"), limit(n));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
}
export const publicarAtualizacao = (titulo, texto) =>
  addDoc(collection(db, "atualizacoes"), { titulo: titulo.trim(), texto: texto.trim(), criadoEm: serverTimestamp() });
export const apagarAtualizacao = (id) => deleteDoc(doc(db, "atualizacoes", id));

// ---------- Arenas (duram no máximo 3 horas) ----------
export const definirArena = (persId, arenaId) => { if (arenaId) arenaDe[persId] = arenaId; else delete arenaDe[persId]; };

export async function minhasArenas() {
  const q = query(collection(db, "arenas"), where("criadorUid", "==", auth.currentUser.uid));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getArena(id) {
  const s = await getDoc(doc(db, "arenas", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export async function criarArena(nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite o nome da arena.");
  const ativas = (await minhasArenas()).filter((a) => a.expiraEm.toMillis() > Date.now());
  if (ativas.length >= 3) throw new Error("Você já tem 3 arenas ativas. Encerre uma antes.");
  const uid = auth.currentUser.uid;
  const ref = doc(collection(db, "arenas"));
  const expiraEm = new Date(Date.now() + 3 * 60 * 60 * 1000);
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo();
    const batch = writeBatch(db);
    batch.set(ref, { nome, criadorUid: uid, codigo, criadaEm: serverTimestamp(), expiraEm });
    batch.set(doc(db, "arenaCodigos", codigo), { arenaId: ref.id, criadorUid: uid, nome, expiraEm });
    try {
      await batch.commit();
      return codigo;
    } catch (e) {
      if (tentativa === 4) throw e;
    }
  }
}

// Apaga a arena, o código e os pontos espelhados dos participantes
export async function encerrarArena(arenaId, codigo) {
  const membros = await getDocs(collection(db, "arenas", arenaId, "membros"));
  const batch = writeBatch(db);
  membros.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, "arenaCodigos", codigo));
  batch.delete(doc(db, "arenas", arenaId));
  await batch.commit();
}

function instantaneo(v, exp) {
  const u = auth.currentUser;
  const zero = { atual: 0, total: 0 };
  const s = {
    donoUid: u.uid, nome: v.nome || "", donoNome: v.donoNome || u.displayName || "",
    pv: v.pv || { atual: 0, total: 0, temp: 0 }, pc: v.pc || zero, pe: v.pe || zero, ps: v.ps || zero, cb: v.cb || zero,
    morrendo: v.morrendo || 0, atualizadoEm: serverTimestamp()
  };
  if (v.pf) s.pf = v.pf;
  if (exp) s.expiraEm = new Date(exp);
  return s;
}

export async function entrarArena(persId, codigo, vivoLocal) {
  const cs = await getDoc(doc(db, "arenaCodigos", codigo.trim().toUpperCase()));
  if (!cs.exists()) throw new Error("Código de arena não encontrado.");
  const { arenaId, nome, expiraEm } = cs.data();
  const exp = expiraEm.toMillis();
  if (exp <= Date.now()) throw new Error("Esta arena já terminou.");
  const campos = { arenaId, arenaNome: nome, arenaExpira: exp };
  const batch = writeBatch(db);
  batch.update(doc(db, "personagens", persId), campos);
  batch.update(doc(db, "vivo", persId), campos);
  batch.set(doc(db, "arenas", arenaId, "membros", persId), instantaneo(vivoLocal, exp));
  await batch.commit();
  arenaDe[persId] = arenaId;
  return { arenaId, nome, exp };
}

export async function sairArena(persId, arenaId) {
  const nulos = { arenaId: null, arenaNome: null, arenaExpira: null };
  const batch = writeBatch(db);
  batch.update(doc(db, "personagens", persId), nulos);
  batch.update(doc(db, "vivo", persId), nulos);
  await batch.commit();
  delete arenaDe[persId];
  try { await deleteDoc(doc(db, "arenas", arenaId, "membros", persId)); } catch (e) {}
}

// Depois de salvar a ficha (nome ou PF podem ter mudado), atualiza o que os outros veem
export async function espelharArena(persId, v) {
  const aid = arenaDe[persId];
  if (!aid) return;
  const s = instantaneo(v, v.arenaExpira);
  if (!v.pf) s.pf = deleteField();
  await setDoc(doc(db, "arenas", aid, "membros", persId), s, { merge: true }).catch(() => {});
}

// Se a arena acabou ou foi apagada, solta os personagens meus que ainda apontam para ela
export async function limparMinhaPresenca(arenaId) {
  const q = query(collection(db, "personagens"),
    where("donoUid", "==", auth.currentUser.uid), where("arenaId", "==", arenaId));
  for (const d of (await getDocs(q)).docs) await sairArena(d.id, arenaId);
}

export const escutarArena = (arenaId, fn, aoErro) =>
  onSnapshot(collection(db, "arenas", arenaId, "membros"),
    (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), aoErro);

// ---------- Invocações (criaturas da campanha) ----------
// invocacoes/{id}: ficha completa (só o mestre e quem tem o controle) | invVivo/{id}: pontos (o jogador vinculado também vê)
const pendInv = {}, timersInv = {};

export function salvarPontosInv(invId, campo, valor) {
  pendInv[invId] = pendInv[invId] || {};
  pendInv[invId][campo] = valor;
  clearTimeout(timersInv[invId]);
  timersInv[invId] = setTimeout(() => enviarPontosInv(invId), 1500);
}

export async function enviarPontosInv(invId) {
  const dados = pendInv[invId];
  if (!dados) return;
  delete pendInv[invId];
  await updateDoc(doc(db, "invVivo", invId), { ...dados, atualizadoEm: serverTimestamp() });
}

export async function criarInvocacao(campanhaId, nome) {
  nome = nome.trim();
  if (!nome) throw new Error("Digite o nome da invocação.");
  const ref = doc(collection(db, "invocacoes"));
  const base = { campanhaId, mestreUid: auth.currentUser.uid, personagemId: null, personagemNome: "",
                 jogadorUid: null, jogadorNome: "", controle: false, nome };
  const batch = writeBatch(db);
  batch.set(ref, { ...base, tamanho: "", custo: "", ficha: {}, criadoEm: serverTimestamp() });
  batch.set(doc(db, "invVivo", ref.id), {
    ...base, pv: { atual: 0, total: 0, temp: 0 }, pc: { atual: 0, total: 0 }, pe: { atual: 0, total: 0 }
  });
  await batch.commit();
  return ref.id;
}

export async function getInvocacao(id) {
  const s = await getDoc(doc(db, "invocacoes", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
export async function getInvVivo(id) {
  const s = await getDoc(doc(db, "invVivo", id));
  return s.exists() ? s.data() : {};
}

const lerInv = (q, fn, aoErro) =>
  onSnapshot(q, (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), aoErro);
export const escutarInvocacoesCampanha = (campId, fn, aoErro) => lerInv(query(collection(db, "invVivo"),
  where("mestreUid", "==", auth.currentUser.uid), where("campanhaId", "==", campId)), fn, aoErro);
export const escutarInvocacoesDoJogador = (fn, aoErro) => lerInv(query(collection(db, "invVivo"),
  where("jogadorUid", "==", auth.currentUser.uid)), fn, aoErro);

export async function salvarInvocacao(invId, topo, ficha) {
  const batch = writeBatch(db);
  batch.update(doc(db, "invocacoes", invId), { ...topo, ficha, atualizadoEm: serverTimestamp() });
  batch.update(doc(db, "invVivo", invId), { nome: topo.nome, atualizadoEm: serverTimestamp() });
  await batch.commit();
}

// Vincula a invocação a um personagem (o invocador); só o mestre muda. p = { id, nome, donoUid, donoNome } ou null
export async function definirPersonagemInv(invId, p, controle) {
  const campos = p
    ? { personagemId: p.id, personagemNome: p.nome, jogadorUid: p.donoUid, jogadorNome: p.donoNome || "", controle: !!controle }
    : { personagemId: null, personagemNome: "", jogadorUid: null, jogadorNome: "", controle: false };
  const batch = writeBatch(db);
  batch.update(doc(db, "invocacoes", invId), campos);
  batch.update(doc(db, "invVivo", invId), campos);
  await batch.commit();
}

export async function apagarInvocacao(invId) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "invocacoes", invId));
  batch.delete(doc(db, "invVivo", invId));
  await batch.commit();
}

// Invocações vinculadas a um personagem: papel "jogador" (dono do personagem) ou "mestre"
export const escutarInvocacoesDoPersonagem = (persId, papel, fn, aoErro) => lerInv(query(collection(db, "invVivo"),
  where(papel === "mestre" ? "mestreUid" : "jogadorUid", "==", auth.currentUser.uid),
  where("personagemId", "==", persId)), fn, aoErro);