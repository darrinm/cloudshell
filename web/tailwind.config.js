/** @type {import('tailwindcss').Config} */
export default {
  future: {
    hoverOnlyWhenSupported: true,
  },
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        iris: {
          bg: 'rgb(var(--iris-bg) / <alpha-value>)',
          'bg-subtle': 'rgb(var(--iris-bg-subtle) / <alpha-value>)',
          surface: 'rgb(var(--iris-surface) / <alpha-value>)',
          'surface-hover': 'rgb(var(--iris-surface-hover) / <alpha-value>)',
          'surface-active': 'rgb(var(--iris-surface-active) / <alpha-value>)',
          'surface-raised': 'rgb(var(--iris-surface-raised) / <alpha-value>)',
          border: 'rgb(var(--iris-border) / <alpha-value>)',
          'border-muted': 'rgb(var(--iris-border-muted) / <alpha-value>)',
          text: 'rgb(var(--iris-text) / <alpha-value>)',
          'text-secondary': 'rgb(var(--iris-text-secondary) / <alpha-value>)',
          'text-muted': 'rgb(var(--iris-text-muted) / <alpha-value>)',
          'text-faint': 'rgb(var(--iris-text-faint) / <alpha-value>)',
          primary: 'rgb(var(--iris-primary) / <alpha-value>)',
          'primary-text': 'rgb(var(--iris-primary-text) / <alpha-value>)',
          success: 'rgb(var(--iris-success) / <alpha-value>)',
          warning: 'rgb(var(--iris-warning) / <alpha-value>)',
          error: 'rgb(var(--iris-error) / <alpha-value>)',
          pending: 'rgb(var(--iris-pending) / <alpha-value>)',
          thinking: 'rgb(var(--iris-thinking) / <alpha-value>)',
        },
      },
      boxShadow: {
        'inset-top': 'inset 0 1px 0 rgba(255,255,255,0.04)',
        'glow-primary': '0 0 12px rgba(var(--iris-primary), 0.15)',
        'card': '0 2px 8px rgba(0,0,0,0.3)',
        'float': '0 8px 24px rgba(0,0,0,0.5)',
      },
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
