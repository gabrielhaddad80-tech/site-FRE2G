// Menu mobile
const burger = document.getElementById("burger");
const nav = document.getElementById("nav");

burger.addEventListener("click", () => {
  const open = nav.classList.toggle("is-open");
  burger.setAttribute("aria-expanded", open);
});

nav.querySelectorAll("a").forEach((link) =>
  link.addEventListener("click", () => {
    nav.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
  })
);

// Formulaire : ouvre le client mail avec la demande pré-remplie
const CONTACT_EMAIL = "electroclimconcept@gmail.com";

document.getElementById("contact-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const subject = `Demande de ${data.get("besoin")} — ${data.get("nom")}`;
  const body = [
    `Nom : ${data.get("nom")}`,
    `Téléphone : ${data.get("telephone")}`,
    `E-mail : ${data.get("email") || "-"}`,
    `Besoin : ${data.get("besoin")}`,
    "",
    data.get("message"),
  ].join("\n");
  window.location.href =
    `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

document.getElementById("year").textContent = new Date().getFullYear();
