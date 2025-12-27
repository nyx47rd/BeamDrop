/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./services/**/*.{js,ts,jsx,tsx}",
    "./*.{js,ts,jsx,tsx}", // Matches App.tsx, index.tsx, types.ts in root
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          850: '#1c1c1e', // Apple Dark Gray
          900: '#121212',
          950: '#000000', // True Black
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      }
    },
  },
  plugins: [],
}