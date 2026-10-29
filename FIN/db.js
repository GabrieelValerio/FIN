import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
         createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile,
         EmailAuthProvider, reauthenticateWithCredential, updatePassword }
  from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, writeBatch,
         updateDoc, setDoc, onSnapshot, deleteField, serverTimestamp }
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
  await updateDoc(doc(db, "vivo", persId), { ...dados, atualizadoEm: serverTimestamp() });
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
  const batch = writeBatch(db);
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
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, nome: d.data().nome, donoNome: d.data().donoNome || "" }));
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