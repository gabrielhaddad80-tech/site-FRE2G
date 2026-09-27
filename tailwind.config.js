/** Charte Electroclim — voir brand-book.html */
module.exports = {
  content: ["./*.html", "./script.js"],
  theme: {
    // Palette fermée : pas de noir pur, pas de gris générique.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#FFFFFF",
      electro: { 50: "#EEF2FA", 100: "#E3EAF6", DEFAULT: "#1B3F8F", 700: "#163474", 900: "#0F2556" },
      eclair: { 50: "#FDEDEE", DEFAULT: "#D7262E", 700: "#B51D24", 300: "#FF8B86" },
      nuit: { DEFAULT: "#0E1A2B", 800: "#16263D" },
      ardoise: { DEFAULT: "#55617A", 300: "#A3ABBA" },
      sable: { DEFAULT: "#F5F3EF", 300: "#E4E1DB", 400: "#D6D2CA" },
    },
    fontFamily: {
      display: ['"Archivo"', '"Helvetica Neue"', "Arial", "sans-serif"],
      sans: ['"Inter"', "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
    },
    extend: {
      borderColor: { DEFAULT: "#E4E1DB" },
      maxWidth: { wrap: "1200px" },
      borderRadius: { DEFAULT: "4px" },
      boxShadow: {
        soft: "0 12px 32px -12px rgba(14, 26, 43, 0.18)",
        header: "0 4px 18px rgba(14, 26, 43, 0.06)",
      },
      transitionTimingFunction: { out: "cubic-bezier(0.22, 1, 0.36, 1)" },
    },
  },
  plugins: [],
};
