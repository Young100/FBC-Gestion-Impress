import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || 'Une erreur inattendue est survenue.',
    };
  }

  render() {
    if (this.state.hasError) {
      let friendly = this.state.message;
      try {
        const parsed = JSON.parse(this.state.message);
        if (parsed.error) {
          friendly = `Erreur de synchronisation Firestore (${parsed.operationType}) : ${parsed.error}`;
        }
      } catch {
        // plain error message
      }

      return (
        <div className="min-h-screen bg-[#EDF2F4] flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white rounded-3xl p-8 border border-slate-200 shadow-sm text-center space-y-5">
            <div className="w-14 h-14 mx-auto rounded-full bg-[#EF233C]/10 text-[#EF233C] flex items-center justify-center">
              <AlertTriangle className="w-7 h-7" />
            </div>
            <h2 className="font-display text-2xl text-[#26547C]">
              Incident technique temporaire
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed break-words">{friendly}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-[#26547C] text-white font-medium text-sm hover:bg-[#1e4466] transition-colors min-h-[44px]"
            >
              <RefreshCw className="w-4 h-4" />
              Recharger l’application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
