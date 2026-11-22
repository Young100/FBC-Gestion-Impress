import React, { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  HelpCircle,
  Loader2,
  Lock,
  LogIn,
  MessageCircle,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { loginClientAccount, registerClientAccount } from '../lib/clientApi';
import type { ClientAccountPublic, Order } from '../types/fbc';

interface ClientAuthPanelProps {
  initialMode?: 'login' | 'register';
  prefilledTrackingCode?: string;
  notice?: string | null;
  shopWhatsapp?: string;
  compact?: boolean;
  onAuthenticated: (account: ClientAccountPublic, claimedOrder?: Order) => void;
}

export const ClientAuthPanel: React.FC<ClientAuthPanelProps> = ({
  initialMode = 'login',
  prefilledTrackingCode = '',
  notice = null,
  shopWhatsapp = '',
  compact = false,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [claimTrackingCode, setClaimTrackingCode] = useState(prefilledTrackingCode);
  const [showClaimInput, setShowClaimInput] = useState(Boolean(prefilledTrackingCode));
  const [showPassword, setShowPassword] = useState(false);
  const [showForgotHelp, setShowForgotHelp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (prefilledTrackingCode) {
      setClaimTrackingCode(prefilledTrackingCode);
      setShowClaimInput(true);
    }
  }, [prefilledTrackingCode]);

  const handleModeSwitch = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!identifier.trim() || !password) {
      setError('Veuillez saisir votre téléphone (ou nom d’utilisateur) et votre mot de passe.');
      return;
    }
    setSubmitting(true);
    try {
      const account = await loginClientAccount(identifier.trim(), password);
      onAuthenticated(account);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Impossible de vous connecter pour le moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError('Choisissez un nom d’utilisateur.');
      return;
    }
    if (fullName.trim().length < 2) {
      setError('Indiquez votre nom complet ou celui de votre entreprise.');
      return;
    }
    if (!phone.trim()) {
      setError('Indiquez votre numéro de téléphone Burkina Faso.');
      return;
    }
    if (password.trim().length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Les deux mots de passe ne correspondent pas.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await registerClientAccount({
        username: username.trim().replace(/^@+/, ''),
        fullName: fullName.trim(),
        phone: phone.trim(),
        password,
        claimTrackingCode: claimTrackingCode.trim() || undefined,
      });
      onAuthenticated(res.account, res.claimedOrder);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Impossible de créer votre compte client.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const whatsappDigits = shopWhatsapp.replace(/\D/g, '');
  const whatsappResetUrl = whatsappDigits
    ? `https://wa.me/${whatsappDigits}?text=${encodeURIComponent(
        'Bonjour FBC Print, j’ai oublié le mot de passe de mon compte client. Pouvez-vous me générer un mot de passe temporaire ?'
      )}`
    : null;

  return (
    <div
      className={`bg-white rounded-3xl border border-slate-200 shadow-sm ${
        compact ? 'p-5 sm:p-6' : 'p-6 sm:p-8'
      } space-y-5`}
    >
      {!compact && (
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#119DA4]/10 text-[#0E7F85] text-xs font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" />
            Espace client confidentiel FBC Print
          </div>
          <h2 className="font-display text-2xl sm:text-3xl text-[#26547C]">
            {mode === 'login' ? 'Accéder à mes commandes' : 'Créer mon compte client'}
          </h2>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            Vos commandes, devis et fichiers restent strictement privés et protégés par votre mot de passe.
          </p>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2.5 text-xs sm:text-sm font-medium text-[#26547C] bg-[#119DA4]/10 border border-[#119DA4]/25 px-4 py-3 rounded-2xl">
          <Lock className="w-4 h-4 text-[#119DA4] shrink-0 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}

      {/* Mode switcher */}
      <div className="grid grid-cols-2 p-1 rounded-2xl bg-[#EDF2F4] gap-1">
        <button
          type="button"
          onClick={() => handleModeSwitch('login')}
          className={`inline-flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-sm font-semibold transition-all min-h-[44px] ${
            mode === 'login'
              ? 'bg-white text-[#26547C] shadow-sm'
              : 'text-slate-600 hover:text-[#26547C]'
          }`}
        >
          <LogIn className="w-4 h-4 shrink-0" />
          Se connecter
        </button>
        <button
          type="button"
          onClick={() => handleModeSwitch('register')}
          className={`inline-flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-sm font-semibold transition-all min-h-[44px] ${
            mode === 'register'
              ? 'bg-white text-[#26547C] shadow-sm'
              : 'text-slate-600 hover:text-[#26547C]'
          }`}
        >
          <UserPlus className="w-4 h-4 shrink-0" />
          Créer un compte
        </button>
      </div>

      {mode === 'login' ? (
        <form onSubmit={handleLoginSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="cli-login-id"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Numéro de téléphone ou nom d’utilisateur
            </label>
            <input
              id="cli-login-id"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Ex : 70 00 00 00 ou jean_k"
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="cli-login-pwd"
                className="block text-sm font-medium text-slate-700"
              >
                Mot de passe
              </label>
              <button
                type="button"
                onClick={() => setShowForgotHelp((v) => !v)}
                className="text-xs font-medium text-[#119DA4] hover:underline inline-flex items-center gap-1"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                Mot de passe oublié ?
              </button>
            </div>
            <div className="relative">
              <input
                id="cli-login-pwd"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Votre mot de passe"
                className="w-full px-4 py-3 pr-12 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-slate-500 hover:text-[#26547C]"
                aria-label={showPassword ? 'Masquer' : 'Afficher'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {showForgotHelp && (
            <div className="p-4 rounded-2xl bg-[#EDF2F4] text-xs sm:text-sm text-slate-700 space-y-2.5">
              <p>
                Par mesure de sécurité, seul l’atelier FBC Print peut réinitialiser votre mot de passe et vous transmettre un code temporaire.
              </p>
              {whatsappResetUrl && (
                <a
                  href={whatsappResetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-[#119DA4]/40 text-[#26547C] font-semibold text-xs hover:bg-[#119DA4]/10"
                >
                  <MessageCircle className="w-3.5 h-3.5 text-[#119DA4]" />
                  Demander une réinitialisation sur WhatsApp
                </a>
              )}
            </div>
          )}

          {error && (
            <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full bg-[#26547C] text-white font-semibold text-base hover:bg-[#1e4466] transition-colors min-h-[48px] disabled:opacity-60"
          >
            {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
            {submitting ? 'Connexion...' : 'Se connecter à mon espace'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleRegisterSubmit} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3.5">
            <div>
              <label
                htmlFor="cli-reg-username"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Nom d’utilisateur *
              </label>
              <input
                id="cli-reg-username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Ex : moussa_ouaga"
                className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
              />
              <span className="text-[11px] text-slate-500 mt-1 block">
                3 à 24 caractères (lettres, chiffres, _ ou -)
              </span>
            </div>

            <div>
              <label
                htmlFor="cli-reg-phone"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Téléphone / WhatsApp *
              </label>
              <input
                id="cli-reg-phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+226 70 00 00 00"
                className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="cli-reg-fullname"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Nom complet ou entreprise *
            </label>
            <input
              id="cli-reg-fullname"
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Ex : Moussa Sawadogo / Éts Faso"
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
            />
          </div>

          <div className="grid sm:grid-cols-2 gap-3.5">
            <div>
              <label
                htmlFor="cli-reg-pwd"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Mot de passe *
              </label>
              <div className="relative">
                <input
                  id="cli-reg-pwd"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min. 6 caractères"
                  className="w-full px-4 py-3 pr-11 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-slate-500 hover:text-[#26547C]"
                  aria-label={showPassword ? 'Masquer' : 'Afficher'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="cli-reg-pwd2"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Confirmer le mot de passe *
              </label>
              <input
                id="cli-reg-pwd2"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Répétez le mot de passe"
                className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
              />
            </div>
          </div>

          {/* Optional pre-existing tracking code claim */}
          <div className="pt-1">
            {!showClaimInput ? (
              <button
                type="button"
                onClick={() => setShowClaimInput(true)}
                className="text-xs font-semibold text-[#119DA4] hover:underline"
              >
                + J’ai déjà un code de suivi FBC-... à rattacher à ce compte
              </button>
            ) : (
              <div className="p-3.5 rounded-2xl bg-[#EDF2F4]/80 border border-slate-200 space-y-1.5">
                <label
                  htmlFor="cli-reg-claim"
                  className="block text-xs font-semibold text-[#26547C]"
                >
                  Code de suivi existant (optionnel)
                </label>
                <input
                  id="cli-reg-claim"
                  type="text"
                  value={claimTrackingCode}
                  onChange={(e) => setClaimTrackingCode(e.target.value.toUpperCase())}
                  placeholder="Ex : FBC-A7K9M2"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 focus:border-[#119DA4] focus:outline-none text-sm font-mono uppercase min-h-[42px]"
                />
                <p className="text-[11px] text-slate-500">
                  Le numéro de téléphone saisi doit correspondre à celui enregistré sur la commande.
                </p>
              </div>
            )}
          </div>

          {error && (
            <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full bg-[#EF233C] text-white font-semibold text-base hover:bg-[#d81b32] transition-colors min-h-[48px] disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <UserPlus className="w-5 h-5" />
            )}
            {submitting ? 'Création du compte...' : 'Créer mon compte et continuer'}
          </button>
        </form>
      )}
    </div>
  );
};
