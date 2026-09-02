import React from 'react';
import './BrandLogo.css';

const LOGO_URL = 'https://dotczcyyzgabmtmnglqj.supabase.co/storage/v1/object/public/Logo/IES%20Logo.jpg';

export function BrandLogo() {
  return <img className="brand-logo" src={LOGO_URL} alt="" aria-hidden="true" />;
}