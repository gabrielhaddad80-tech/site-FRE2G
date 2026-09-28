/** Charte Electroclim — voir brand-book.html */
module.exports = {
  content: ["./*.html", "./script.js"],
  theme: {
    // Palette fermée : pas de noir pur, pas de gris générique.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#FFFFFF",
      electro: { 50: "#EEF3FA", 100: "#E1EAF6", 400: "#1E88E5", DEFAULT: "#0A2D66", 700: "#163474", 900: "#0F2556" },
      eclair: { 50: "#FDEDEE", DEFAULT: "#E3211C", 700: "#C01A16", 300: "#FF8B86" },
      nuit: { DEFAULT: "#0E1A2B", 800: "#16263D", 950: "#0A1320" },
      ardoise: { DEFAULT: "#55617A", 300: "#A3ABBA" },
      sable: { DEFAULT: "#F5F3EF", 300: "#E4E1DB", 400: "#D6D2CA" },
      ivoire: { DEFAULT: "#F7F3EC", 200: "#EDE6DA" },
    },
    fontFamily: {
      display: ['"Inter"', "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
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
