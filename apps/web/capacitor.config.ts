import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cc.randalls.gauntlet',
  appName: 'Gauntlet',
  webDir: 'dist',
  backgroundColor: '#0c0c0d',
  android: {
    // Health Connect requires API 26+; set in android/variables.gradle too.
    allowMixedContent: false,
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;
