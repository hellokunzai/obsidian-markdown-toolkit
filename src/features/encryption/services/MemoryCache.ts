export class MemoryCache<T> {

	private values = new Map<string,T>();

	public put(key: string, value: T): void {
		//console.debug('MemoryCache.put', {key, value});
		this.values.set( key, value );
	}

	public get(key: string, defaultValue: T): T {
		//console.debug('MemoryCache.get', {key, defaultValue});
		return this.values.get(key) ?? defaultValue;
	}
	
	public getOrNull(key: string): T | null {
		//console.debug('MemoryCache.getOrNull', {key});
		return this.values.get(key) ?? null;
	}

	public getFirst(keys: string[], defaultValue: T): T {
		//console.debug('MemoryCache.getFirst', {keys, defaultValue});
		
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			if (this.containsKey(key)) {
				return this.get(key, defaultValue);
			}
		}

		return defaultValue;
	}

	public containsKey(key: string): boolean {
		//console.debug('MemoryCache.containsKey', {key});
		return this.values.has(key);
	}

	public getKeys(): string[] {
		//console.debug('MemoryCache.getKeys');
		return Array.from( this.values.keys() );
	}

	public removeKey( key: string ) : boolean{
		return this.values.delete( key );
	}

	public removeKeysWithPrefix( prefix: string ) : number {
		let removed = 0;
		for ( const key of this.getKeys() ) {
			if ( key.startsWith( prefix ) ) {
				this.values.delete( key );
				removed++;
			}
		}
		return removed;
	}

	public clear() {
		this.values.clear();
	}
}
