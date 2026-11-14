/**
 * The TaskFlow Android app's phone features, when this page runs inside it.
 *
 * In the app, Capacitor provides the native plugin "TaskFlowPhone" (see
 * apps/android). In a browser there is none, and every Call button falls back
 * to the phone's dialler (tel:). The browser walk-through stands in for the
 * app by setting window.__TASKFLOW_PHONE__ before the page loads; nothing else
 * uses that hook.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

let plugin = null;

export function phoneBridge() {
  if (typeof window !== 'undefined' && window.__TASKFLOW_PHONE__) return window.__TASKFLOW_PHONE__;
  try {
    if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('TaskFlowPhone')) {
      plugin = plugin || registerPlugin('TaskFlowPhone');
      return plugin;
    }
  } catch { /* not in the app */ }
  return null;
}

export const inAndroidApp = () => Boolean(phoneBridge());
