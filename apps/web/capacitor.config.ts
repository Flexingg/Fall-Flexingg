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
    // Native HTTP bypasses CORS, so direct mode can call SparkyFitness without any server-side change.
    CapacitorHttp: { enabled: true },
    // Back is handled by our own PredictiveBackPlugin (so Android can animate it); the App plugin's
    // always-on callback would swallow every back press.
    App: { disableBackButtonHandler: true },
  },
};

export default config;
