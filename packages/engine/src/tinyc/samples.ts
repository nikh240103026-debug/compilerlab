export interface TinySample {
  id: string;
  title: string;
  description: string;
  source: string;
  /** What the program prints, one entry per line. */
  expectedOutput: string[];
}

export const TINYC_SAMPLES: readonly TinySample[] = [
  {
    id: 'factorial',
    title: 'Factorial',
    description: 'Recursion: each call gets its own frame.',
    source: `int factorial(int n) {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

int main() {
  print(factorial(5));
  return 0;
}
`,
    expectedOutput: ['120'],
  },
  {
    id: 'fibonacci',
    title: 'Fibonacci',
    description: 'Double recursion inside a while loop.',
    source: `int fib(int n) {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

int main() {
  int i = 0;
  while (i < 10) {
    print(fib(i));
    i = i + 1;
  }
  return 0;
}
`,
    expectedOutput: ['0', '1', '1', '2', '3', '5', '8', '13', '21', '34'],
  },
  {
    id: 'bubble-sort',
    title: 'Bubble sort',
    description:
      'A local array, passed to a function by reference. Good input for the loop passes.',
    source: `void sort(int a[], int n) {
  int i = 0;
  while (i < n) {
    int j = 0;
    while (j < n - i - 1) {
      if (a[j] > a[j + 1]) {
        int temp = a[j];
        a[j] = a[j + 1];
        a[j + 1] = temp;
      }
      j = j + 1;
    }
    i = i + 1;
  }
}

int main() {
  int a[6];
  a[0] = 5;
  a[1] = 2;
  a[2] = 9;
  a[3] = 1;
  a[4] = 7;
  a[5] = 3;
  sort(a, 6);
  int i = 0;
  while (i < 6) {
    print(a[i]);
    i = i + 1;
  }
  return 0;
}
`,
    expectedOutput: ['1', '2', '3', '5', '7', '9'],
  },
  {
    id: 'primes',
    title: 'Primes',
    description: 'A bool function, and a return from inside a loop.',
    source: `bool isPrime(int n) {
  if (n < 2) {
    return false;
  }
  int d = 2;
  while (d * d <= n) {
    if (n % d == 0) {
      return false;
    }
    d = d + 1;
  }
  return true;
}

int main() {
  int n = 2;
  while (n < 20) {
    if (isPrime(n)) {
      print(n);
    }
    n = n + 1;
  }
  return 0;
}
`,
    expectedOutput: ['2', '3', '5', '7', '11', '13', '17', '19'],
  },
  {
    id: 'short-circuit',
    title: 'Short-circuit booleans',
    description: 'The right side of && and || runs only when it can change the answer.',
    source: `bool loud(bool b) {
  print(b);
  return b;
}

int main() {
  if (false && loud(true)) {
    print(1);
  }
  if (true || loud(false)) {
    print(2);
  }
  if (true && loud(true)) {
    print(3);
  }
  return 0;
}
`,
    expectedOutput: ['2', 'true', '3'],
  },
  {
    id: 'optimizer-showcase',
    title: 'Optimizer showcase',
    description: 'Constants to fold, a repeated expression, dead code, and a multiply in a loop.',
    source: `int main() {
  int a = 3;
  int b = a * 4;
  int unused = b + 1;
  int total = 0;
  int i = 0;
  int n = 5;
  while (i < n) {
    total = total + (a + b) * 8 + i * 4;
    i = i + 1;
  }
  print(total);
  return 0;
}
`,
    // (3 + 12) * 8 is 120 on each of 5 trips, plus 4 * (0 + 1 + 2 + 3 + 4), which is 40.
    expectedOutput: ['640'],
  },
];

export function tinycSample(id: string): TinySample | undefined {
  return TINYC_SAMPLES.find((sample) => sample.id === id);
}
