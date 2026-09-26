import { FileData } from "./FileDataHelper";
import { CryptoHelper } from "./CryptoHelper";
import { ICryptoHelper } from "./ICryptoHelper";
import { CryptoHelper2304 } from "./CryptoHelper2304";

export class CryptoHelperFactory{

	public static cryptoHelper2304_v2 = new CryptoHelper2304( 16, 16, 210000 );

	public static BuildDefault(): ICryptoHelper{
		return this.cryptoHelper2304_v2;
	}

	public static BuildFromFileDataOrThrow( data: FileData ) : ICryptoHelper {
		const result = CryptoHelperFactory.BuildFromFileDataOrNull(data);
		if ( result != null ){
			return result;
		}
		throw new Error( `Unable to determine ICryptoHelper for File ver ${data.version}`);
	}

	public static BuildFromFileDataOrNull( data: FileData ) : ICryptoHelper | null {
		if ( data.version == '1.0' ){
			return new CryptoHelper();
		}

		// note				v2.0	CryptoHelper2304
		if ( data.version == '2.0' ){
			return this.cryptoHelper2304_v2;
		}

		return null;
	}



}