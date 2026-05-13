/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
        retro: ['"VT323"', 'monospace'],
        body: ['"VT323"', 'monospace'],
      },
      colors: {
        retro: {
          bg: '#0a0a2e',
          panel: '#1a1a4e',
          border: '#4a4a8a',
          gold: '#FFD700',
          cyan: '#00FFFF',
          magenta: '#FF00FF',
          lime: '#00FF00',
          red: '#FF3333',
          blue: '#3333FF',
          orange: '#FF8800',
          win: '#00FF88',
          lose: '#FF4444',
        }
      },
      animation: {
        'blink': 'blink 1s step-end infinite',
        'scanline': 'scanline 8s linear infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'marquee': 'marquee 20s linear infinite',
      },
      keyframes: {
        blink: { '50%': { opacity: '0' } },
        scanline: { '0%': { transform: 'translateY(-100%)' }, '100%': { transform: 'translateY(100%)' } },
        glow: { '0%': { textShadow: '0 0 5px currentColor' }, '100%': { textShadow: '0 0 20px currentColor, 0 0 40px currentColor' } },
        marquee: { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'translateX(-100%)' } },
      }
    },
  },
  plugins: [],
};
