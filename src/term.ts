// Абстракция консольного ввода-вывода, чтобы workflow не зависел от readline.

export interface Term {
  print(s?: string): void;
  ask(q: string): Promise<string>;
  pick(prompt: string, options: string[]): Promise<string>;
  yesNo(prompt: string): Promise<boolean>;
}
