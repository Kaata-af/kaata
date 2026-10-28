/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  readonly VITE_WHATSAPP_CONTACT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
