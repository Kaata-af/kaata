import type { ReactNode } from "react";

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-12 -z-10 rounded-full opacity-50 blur-3xl"
        style={{
          background: "radial-gradient(circle, rgba(196,154,60,0.18), transparent 70%)",
        }}
      />
      <div className="w-[280px] aspect-[280/580] bg-white rounded-[2.5rem] border-[10px] border-neutral-900 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.25)] overflow-hidden flex flex-col">
        {/* iPhone-like notch */}
        <div className="h-7 bg-neutral-900 mx-auto w-32 rounded-b-2xl shrink-0 mb-3" />
        <div className="px-5 pb-7 flex-1 flex flex-col">{children}</div>
      </div>
    </div>
  );
}

function CustomerRow({ name, balance }: { name: string; balance: number }) {
  const color = balance < 0 ? "text-red-600" : balance > 0 ? "text-green-700" : "text-neutral-400";
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-neutral-200 last:border-0">
      <span className="text-[13px] font-medium text-neutral-900">{name}</span>
      <span className={`text-[13px] font-semibold ${color}`}>
        {balance.toLocaleString("en-US")} AFN
      </span>
    </div>
  );
}

export function PhoneMockupHome() {
  return (
    <PhoneFrame>
      <p className="text-[10px] font-semibold text-neutral-500 mt-1">Sultan Shop</p>
      <p className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mt-4">
        Owed to you
      </p>
      <p className="text-[34px] font-bold text-neutral-900 mt-0.5 leading-none">
        12,400 <span className="text-sm text-neutral-500 font-normal">AFN</span>
      </p>

      <div className="mt-7">
        <CustomerRow name="Mahmood" balance={-3800} />
        <CustomerRow name="Ahmad" balance={-1250} />
        <CustomerRow name="Sultan" balance={-750} />
        <CustomerRow name="Karim" balance={200} />
        <CustomerRow name="Reza" balance={0} />
        <CustomerRow name="Wahid" balance={-420} />
      </div>

      <div className="mt-auto flex justify-end pt-4">
        <div className="w-11 h-11 bg-neutral-900 rounded-full flex items-center justify-center text-white text-xl font-light shadow-md">
          +
        </div>
      </div>
    </PhoneFrame>
  );
}

export function PhoneMockupWhatsApp() {
  return (
    <PhoneFrame>
      <div className="flex items-center gap-2 mt-1 pb-3 border-b border-neutral-200">
        <div className="w-7 h-7 rounded-full bg-neutral-300 flex items-center justify-center text-[10px] font-semibold text-neutral-600">
          A
        </div>
        <div>
          <p className="text-[13px] font-semibold text-neutral-900 leading-tight">Ahmad</p>
          <p className="text-[10px] text-neutral-500">+93 70 123 4567</p>
        </div>
      </div>

      <div className="mt-5 space-y-3 flex-1">
        <div className="ml-auto max-w-[88%] bg-[#dcf8c6] rounded-2xl rounded-br-sm px-3 py-2.5 text-[12px] text-neutral-900 leading-relaxed">
          Salaam Ahmad.
          <br />
          <br />
          Your kaata at Sultan Shop:
          <br />
          Balance: −1,250 AFN
          <br />
          <br />
          <span className="text-neutral-500">— Sent via Kaata.af</span>
          <div className="mt-1 text-right text-[9px] text-neutral-500">
            10:23 AM <span className="text-sky-600">✓✓</span>
          </div>
        </div>

        <div className="mr-auto max-w-[60%] bg-white border border-neutral-200 rounded-2xl rounded-bl-sm px-3 py-2 text-[12px] text-neutral-900 shadow-sm">
          Thank you for the reminder.
          <div className="mt-0.5 text-right text-[9px] text-neutral-500">10:31 AM</div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 bg-neutral-100 rounded-full px-3 py-2">
        <span className="text-[11px] text-neutral-400 flex-1">Reply…</span>
        <div className="w-6 h-6 rounded-full bg-emerald-500" />
      </div>
    </PhoneFrame>
  );
}

export function PhoneMockupOffline() {
  return (
    <PhoneFrame>
      <div className="flex items-center justify-between mt-1">
        <p className="text-[10px] font-semibold text-neutral-500">Sultan Shop</p>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-neutral-400" />
          <span className="text-[9px] text-neutral-500 uppercase tracking-wider">Offline</span>
        </div>
      </div>

      <p className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mt-5">
        Owed to you
      </p>
      <p className="text-[34px] font-bold text-neutral-900 mt-0.5 leading-none">
        12,400 <span className="text-sm text-neutral-500 font-normal">AFN</span>
      </p>

      <div className="mt-6">
        <CustomerRow name="Ahmad" balance={-1250} />
        <CustomerRow name="Mahmood" balance={-3800} />
        <CustomerRow name="Sultan" balance={-750} />
        <CustomerRow name="Karim" balance={200} />
      </div>

      <div className="mt-auto rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5">
        <p className="text-[10px] font-medium text-neutral-700 leading-tight">New debt recorded.</p>
        <p className="text-[10px] text-neutral-500 leading-tight mt-0.5">
          Saved on this device. No internet needed.
        </p>
      </div>
    </PhoneFrame>
  );
}
