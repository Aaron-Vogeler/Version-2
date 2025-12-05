'use client';

/**
 * Beautiful, minimalist loading screen component
 * Features smooth animations, charming design, and better typography
 */

interface LoadingScreenProps {
  message?: string;
  variant?: 'default' | 'subtle' | 'minimal';
}

export function LoadingScreen({ message = 'Loading...', variant = 'default' }: LoadingScreenProps) {
  return (
    <div className="fixed inset-0 flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {/* Animated background decoration */}
      <div className="absolute inset-0 opacity-30 dark:opacity-20">
        <div className="absolute left-1/4 top-1/4 h-64 w-64 rounded-full bg-gradient-to-br from-blue-200 to-transparent blur-3xl animate-float"></div>
        <div className="absolute right-1/4 bottom-1/4 h-64 w-64 rounded-full bg-gradient-to-br from-purple-200 to-transparent blur-3xl animate-float-delayed"></div>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center justify-center space-y-6 px-4">
        {/* Animated loader */}
        <div className="relative flex h-16 w-16 items-center justify-center">
          {/* Outer rotating ring */}
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-slate-400 border-r-slate-400 animate-spin dark:border-t-slate-500 dark:border-r-slate-500"></div>

          {/* Middle pulsing ring */}
          <div className="absolute inset-2 rounded-full border border-slate-300 animate-pulse dark:border-slate-600"></div>

          {/* Inner dot */}
          <div className="h-2 w-2 rounded-full bg-gradient-to-r from-blue-500 to-purple-500 animate-pulse"></div>
        </div>

        {/* Text content */}
        <div className="space-y-2 text-center">
          <p className="text-lg font-medium tracking-tight text-slate-700 dark:text-slate-200 animate-fade-in">
            {message}
          </p>
          <div className="flex items-center justify-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400 animate-dot-pulse"></span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400 animate-dot-pulse animation-delay-200"></span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400 animate-dot-pulse animation-delay-400"></span>
          </div>
        </div>

        {/* Subtle hint text */}
        <p className="text-sm font-light text-slate-500 dark:text-slate-400 animate-fade-in animation-delay-300">
          Just a moment...
        </p>
      </div>
    </div>
  );
}
