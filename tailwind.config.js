export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      boxShadow: {
        'glass': '0 8px 32px 0 rgba(15, 23, 42, 0.04)',
        'glass-hover': '0 12px 48px 0 rgba(15, 23, 42, 0.08)',
        'soft-xl': '0 20px 40px -15px rgba(0,0,0,0.05)',
        'inner-light': 'inset 0 2px 4px 0 rgba(255, 255, 255, 0.8)',
      },
      colors: {
        slate: {
          850: '#151e2e',
        }
      },
      animation: {
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-4px)' },
        }
      }
    },
  },
  plugins: [],
};
