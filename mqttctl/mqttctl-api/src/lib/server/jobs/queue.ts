export class JobQueue {
  private next: Promise<unknown> = Promise.resolve();

  enqueue<T>({ name, run }: { name: string; run: () => Promise<T> }) {
    const job = this.next.then(async () => await run());
    this.next = job.catch(() => undefined);
    return job;
  }

  async idle() {
    await this.next;
  }
}

