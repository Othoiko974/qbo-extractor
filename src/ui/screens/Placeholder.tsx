import React from 'react';

export function Placeholder({ title }: { title: string }) {
  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <b>{title}</b>
        </div>
      </div>
      <div className="content pad" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="placeholder-box" style={{ padding: '40px 60px' }}>
          Écran « {title} » — à implémenter
        </div>
      </div>
    </div>
  );
}
