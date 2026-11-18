/** 面板专用 Tailwind:扫描移植的设计器源码,产出它用到的 utility 集(含广场自定义色 token 与 keyframes)。 */
export default {
  content: ['./src/client/*.tsx'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#1f2937' },
        cream: '#FDFAF2',
        gold: { DEFAULT: '#F8BD61', dark: '#C6871F' },
      },
      boxShadow: {
        card: '0 1px 3px rgba(31,41,55,.08), 0 4px 14px rgba(31,41,55,.06)',
      },
      keyframes: {
        'flow-run-breathe': {
          '0%, 100%': { 'box-shadow': '0 0 0 2px #C6871F' },
          '50%': { 'box-shadow': '0 0 0 6px rgba(198,135,31,.35)' },
        },
        'flow-edge-march': { to: { 'stroke-dashoffset': '-24' } },
        'dropdown-in': {
          from: { opacity: '0', transform: 'translateY(-4px) scale(.98)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'flow-run-breathe': 'flow-run-breathe 1.6s ease-in-out infinite',
        'flow-edge-march': 'flow-edge-march .9s linear infinite',
        'dropdown-in': 'dropdown-in 120ms ease-out',
      },
    },
  },
  plugins: [],
};
