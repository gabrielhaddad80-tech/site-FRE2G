// Menu mobile
const burger = document.getElementById("burger");
const nav = document.getElementById("nav");

burger.addEventListener("click", () => {
  const open = nav.classList.toggle("is-open");
  burger.setAttribute("aria-expanded", String(open));
});

nav.querySelectorAll("a").forEach((link) =>
  link.addEventListener("click", () => {
    nav.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
  })
);

// Ombre sous l'en-tête dès que la page défile
const header = document.getElementById("header");
const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Formulaire : ouvre la messagerie avec la demande pré-remplie
const CONTACT_EMAIL = "electroclimconcept@gmail.com";

document.getElementById("contact-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const subject = `${data.get("besoin")} — ${data.get("nom")} (${data.get("profil")})`;
  const body = [
    `Nom : ${data.get("nom")}`,
    `Profil : ${data.get("profil")}`,
    `Téléphone : ${data.get("telephone")}`,
    `E-mail : ${data.get("email") || "-"}`,
    `Ville : ${data.get("ville") || "-"}`,
    `Besoin : ${data.get("besoin")}`,
    "",
    data.get("message"),
  ].join("\n");
  window.location.href =
    `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

document.getElementById("year").textContent = new Date().getFullYear();
