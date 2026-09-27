// Menu mobile
const burger = document.getElementById("burger");
const nav = document.getElementById("nav");

if (burger && nav) {
  burger.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    burger.setAttribute("aria-expanded", String(open));
    document.getElementById("header")?.classList.toggle("is-solid", open);
  });

  nav.querySelectorAll("a").forEach((link) =>
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      burger.setAttribute("aria-expanded", "false");
      document.getElementById("header")?.classList.remove("is-solid");
    })
  );
}

// Ombre sous l'en-tête dès que la page défile
const header = document.getElementById("header");
if (header) {
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canObserve = "IntersectionObserver" in window;

// Apparition discrète des blocs au défilement (voir [data-reveal] dans src/site.css)
const revealed = document.querySelectorAll("[data-reveal]");

if (reduceMotion || !canObserve) {
  revealed.forEach((el) => el.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (!isIntersecting) return;
        target.classList.add("is-visible");
        obs.unobserve(target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );
  revealed.forEach((el) => revealObserver.observe(el));
}

// Vidéos de chantier : lecture muette quand elles sont visibles, pause sinon.
// Si l'utilisateur limite les animations, on affiche simplement les contrôles.
const videos = document.querySelectorAll(".media video");

if (reduceMotion || !canObserve) {
  videos.forEach((v) => (v.controls = true));
} else {
  const videoObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) {
          target.play().catch((err) => {
            // Lecture automatique refusée par le navigateur : on laisse la main au visiteur.
            if (err.name === "NotAllowedError") target.controls = true;
          });
        } else if (!target.paused) {
          target.pause();
        }
      });
    },
    { threshold: 0.4 }
  );
  videos.forEach((v) => videoObserver.observe(v));
}

// Formulaire : ouvre la messagerie avec la demande pré-remplie
const CONTACT_EMAIL = "electroclimconcept@gmail.com";
const form = document.getElementById("contact-form");

if (form) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const subject = `${data.get("besoin")} — ${data.get("nom")} (${data.get("profil")})`;
    const body = [
      `Nom : ${data.get("nom")}`,
      `Profil : ${data.get("profil")}`,
      `Téléphone : ${data.get("telephone")}`,
      `Besoin : ${data.get("besoin")}`,
      "",
      data.get("message"),
    ].join("\n");
    window.location.href =
      `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
}

const year = document.getElementById("year");
if (year) year.textContent = new Date().getFullYear();
