/**
 * designSystem.ts — Enterprise SaaS design system
 * 
 * Color palette: Accessible, operational authority, municipal compliance
 * Typography: Clear hierarchy, tight tracking, high contrast
 * Spacing: 4px grid, 8px-based rhythm
 * Components: Tactile, state-clear, WCAG AA+ compliant
 */

export const DESIGN_SYSTEM = {
  colors: {
    // Brand & primary
    primary: {
      50: '#f0f6ff',
      100: '#e0ecff',
      200: '#bfe1ff',
      300: '#9ed3ff',
      400: '#6eb9ff',
      500: '#3e96ff', // Primary action
      600: '#2e7dd4',
      700: '#2463b8',
      800: '#1f5399',
      900: '#1a427d',
    },
    // Neutral: slate gray (professional, legible)
    neutral: {
      0: '#ffffff',
      50: '#f9fafb',
      100: '#f3f4f6',
      200: '#e5e7eb',
      300: '#d1d5db',
      400: '#9ca3af',
      500: '#6b7280',
      600: '#4b5563',
      700: '#374151',
      800: '#1f2937',
      900: '#111827',
    },
    // Status colors: operational clarity
    success: {
      light: '#d1fae5',
      main: '#10b981',
      dark: '#047857',
    },
    warning: {
      light: '#fed7aa',
      main: '#f59e0b',
      dark: '#d97706',
    },
    error: {
      light: '#fecaca',
      main: '#ef4444',
      dark: '#dc2626',
    },
    info: {
      light: '#dbeafe',
      main: '#0ea5e9',
      dark: '#0284c7',
    },
    // Compliance & enforcement specific
    breach: '#ef4444',
    compliant: '#10b981',
    pending: '#f59e0b',
    critical: '#7c2d12',
  },
  typography: {
    // Font families
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: '"SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace',
    },
    // Scales: tight leading for authority, generous tracking for navigation
    sizes: {
      xs: '11px',
      sm: '12px',
      base: '14px',
      lg: '16px',
      xl: '18px',
      '2xl': '20px',
      '3xl': '24px',
      '4xl': '32px',
      '5xl': '48px',
    },
    weights: {
      regular: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    lineHeights: {
      tight: 1.2,
      normal: 1.5,
      relaxed: 1.75,
    },
    letterSpacing: {
      tight: '-0.01em',
      normal: '0em',
      wide: '0.05em',
      wider: '0.1em',
    },
  },
  spacing: {
    0: '0px',
    1: '4px',
    2: '8px',
    3: '12px',
    4: '16px',
    5: '20px',
    6: '24px',
    7: '28px',
    8: '32px',
    9: '36px',
    10: '40px',
    12: '48px',
    16: '64px',
    20: '80px',
    24: '96px',
  },
  borderRadius: {
    none: '0px',
    xs: '2px',
    sm: '4px',
    md: '6px',
    lg: '8px',
    xl: '12px',
    '2xl': '16px',
    full: '9999px',
  },
  shadows: {
    xs: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    sm: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  },
  transitions: {
    fast: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
    base: '250ms cubic-bezier(0.4, 0, 0.2, 1)',
    slow: '350ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
  breakpoints: {
    xs: '320px',
    sm: '640px',
    md: '1024px',
    lg: '1280px',
    xl: '1536px',
  },
  zIndex: {
    hide: -1,
    base: 0,
    dropdown: 1000,
    sticky: 1020,
    fixed: 1030,
    modal: 1040,
    popover: 1060,
    tooltip: 1070,
  },
};

/**
 * Component preset styles for reuse across the app
 */
export const COMPONENT_STYLES = {
  button: {
    base: {
      fontFamily: DESIGN_SYSTEM.typography.fontFamily.sans,
      fontSize: DESIGN_SYSTEM.typography.sizes.base,
      fontWeight: DESIGN_SYSTEM.typography.weights.medium,
      padding: `${DESIGN_SYSTEM.spacing[2]} ${DESIGN_SYSTEM.spacing[4]}`,
      borderRadius: DESIGN_SYSTEM.borderRadius.md,
      border: 'none',
      cursor: 'pointer',
      transition: `all ${DESIGN_SYSTEM.transitions.fast}`,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: DESIGN_SYSTEM.spacing[2],
      outline: 'none',
    } as React.CSSProperties,
    primary: {
      backgroundColor: DESIGN_SYSTEM.colors.primary[500],
      color: DESIGN_SYSTEM.colors.neutral[0],
      '&:hover': {
        backgroundColor: DESIGN_SYSTEM.colors.primary[600],
      },
      '&:active': {
        backgroundColor: DESIGN_SYSTEM.colors.primary[700],
      },
      '&:disabled': {
        backgroundColor: DESIGN_SYSTEM.colors.neutral[300],
        color: DESIGN_SYSTEM.colors.neutral[500],
        cursor: 'not-allowed',
      },
    } as React.CSSProperties,
    secondary: {
      backgroundColor: DESIGN_SYSTEM.colors.neutral[100],
      color: DESIGN_SYSTEM.colors.primary[600],
      border: `1px solid ${DESIGN_SYSTEM.colors.neutral[300]}`,
      '&:hover': {
        backgroundColor: DESIGN_SYSTEM.colors.neutral[200],
      },
    } as React.CSSProperties,
    danger: {
      backgroundColor: DESIGN_SYSTEM.colors.error.main,
      color: DESIGN_SYSTEM.colors.neutral[0],
      '&:hover': {
        backgroundColor: DESIGN_SYSTEM.colors.error.dark,
      },
    } as React.CSSProperties,
  },
  card: {
    backgroundColor: DESIGN_SYSTEM.colors.neutral[0],
    border: `1px solid ${DESIGN_SYSTEM.colors.neutral[200]}`,
    borderRadius: DESIGN_SYSTEM.borderRadius.lg,
    padding: DESIGN_SYSTEM.spacing[6],
    boxShadow: DESIGN_SYSTEM.shadows.sm,
  } as React.CSSProperties,
  input: {
    fontFamily: DESIGN_SYSTEM.typography.fontFamily.sans,
    fontSize: DESIGN_SYSTEM.typography.sizes.base,
    padding: `${DESIGN_SYSTEM.spacing[2]} ${DESIGN_SYSTEM.spacing[3]}`,
    borderRadius: DESIGN_SYSTEM.borderRadius.md,
    border: `1px solid ${DESIGN_SYSTEM.colors.neutral[300]}`,
    backgroundColor: DESIGN_SYSTEM.colors.neutral[50],
    color: DESIGN_SYSTEM.colors.neutral[900],
    transition: `border-color ${DESIGN_SYSTEM.transitions.fast}`,
    '&:focus': {
      outline: 'none',
      borderColor: DESIGN_SYSTEM.colors.primary[500],
      boxShadow: `0 0 0 3px ${DESIGN_SYSTEM.colors.primary[50]}`,
    },
  } as React.CSSProperties,
};
