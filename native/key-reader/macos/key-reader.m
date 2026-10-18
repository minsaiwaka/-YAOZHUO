// Original, read-only key candidate reader. It never changes target signatures,
// entitlements, memory, process state, or system security settings.
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <mach/vm_region.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <time.h>
#include <stdint.h>
#include <string.h>

static NSMutableSet<NSString *> *salts;
static NSMutableSet<NSString *> *seen;
static BOOL testMode = NO, limited = NO;
static uint64_t scanned = 0;
static const uint64_t maxBytes = 8ULL * 1024 * 1024 * 1024;
static double started;
static double now(void) { return [NSDate timeIntervalSinceReferenceDate]; }
static void output(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}
static BOOL hexByte(uint8_t c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static NSString *hex(const uint8_t *bytes, size_t count) {
  static const char digits[] = "0123456789abcdef";
  char text[193]; if (count > 96) return nil;
  for (size_t i = 0; i < count; ++i) { text[i * 2] = digits[bytes[i] >> 4]; text[i * 2 + 1] = digits[bytes[i] & 15]; }
  return [[NSString alloc] initWithBytes:text length:count * 2 encoding:NSASCIIStringEncoding];
}
static void candidate(NSString *key, NSString *salt) {
  if (!key || key.length != 64 || seen.count >= 512) return;
  NSString *identity = [NSString stringWithFormat:@"%@:%@", key, salt ?: @""];
  if ([seen containsObject:identity]) return;
  [seen addObject:identity];
  if (!testMode) output(salt ? @{ @"type": @"candidate", @"key": key, @"salt": salt } : @{ @"type": @"candidate", @"key": key });
}
static uint64_t word(const uint8_t *p) { uint64_t value; memcpy(&value, p, sizeof(value)); return value; }
static BOOL randomEnough(const uint8_t *p) {
  BOOL used[256] = {0}; size_t distinct = 0, printable = 0;
  for (size_t i = 0; i < 32; i++) { if (!used[p[i]]) { used[p[i]] = YES; distinct++; } if (p[i] >= 32 && p[i] <= 126) printable++; }
  return distinct >= 12 && printable <= 24;
}
static void parse(const uint8_t *bytes, size_t length, mach_port_t task) {
  for (size_t i = 0; i + 67 < length && seen.count < 512; i++) {
    if (bytes[i] == 'x' || bytes[i] == 'X') {
      size_t stride = bytes[i + 1] == 0 ? 2 : 1;
      if (i + 2 * stride >= length || bytes[i + stride] != '\'') continue;
      if (stride == 2 && bytes[i + 3] != 0) continue;
      char value[97]; size_t count = 0;
      while (count < 96 && i + (2 + count) * stride < length) {
        size_t index = i + (2 + count) * stride;
        if (!hexByte(bytes[index]) || (stride == 2 && (index + 1 >= length || bytes[index + 1] != 0))) break;
        value[count++] = (char)bytes[index];
      }
      size_t end = i + (2 + count) * stride;
      if ((count == 64 || count == 96) && end < length && bytes[end] == '\'') {
        NSString *key = [[[NSString alloc] initWithBytes:value length:64 encoding:NSASCIIStringEncoding] lowercaseString];
        NSString *salt = count == 96 ? [[[NSString alloc] initWithBytes:value + 64 length:32 encoding:NSASCIIStringEncoding] lowercaseString] : nil;
        if (!salt || [salts containsObject:salt]) candidate(key, salt);
      }
    }
    // libc++ long strings carry a capacity flag, length, and heap pointer.
    if (i + 24 <= length && word(bytes + i + 8) == 32) {
      uint64_t capacity = word(bytes + i), pointer = word(bytes + i + 16);
      if ((capacity & 1) && (capacity & ~1ULL) >= 32 && (capacity & ~1ULL) <= 128 && pointer > 0x10000 && pointer < 0x0000800000000000ULL) {
        uint8_t raw[32]; mach_vm_size_t read = 0;
        if (mach_vm_read_overwrite(task, pointer, sizeof(raw), (mach_vm_address_t)raw, &read) == KERN_SUCCESS && read == 32 && randomEnough(raw)) candidate(hex(raw, 32), nil);
        memset(raw, 0, sizeof(raw));
      }
    }
  }
}
static void scan(mach_port_t task) {
  mach_vm_address_t address = 0; natural_t depth = 0;
  const size_t chunkSize = 4 * 1024 * 1024, overlap = 256;
  uint8_t *bytes = malloc(chunkSize + overlap);
  if (!bytes) return;
  while (seen.count < 512 && scanned < maxBytes && now() - started < 60) {
    mach_vm_size_t size = 0;
    vm_region_submap_info_data_64_t info;
    mach_msg_type_number_t count = VM_REGION_SUBMAP_INFO_COUNT_64;
    kern_return_t status = mach_vm_region_recurse(task, &address, &size, &depth, (vm_region_recurse_info_t)&info, &count);
    if (status != KERN_SUCCESS || !size) break;
    if (info.is_submap) { depth++; continue; }
    if ((info.protection & VM_PROT_READ) && (info.protection & VM_PROT_WRITE)) {
      for (uint64_t offset = 0; offset < size && seen.count < 512; ) {
        if (scanned >= maxBytes || now() - started >= 60) { limited = YES; break; }
        size_t amount = (size_t)MIN((uint64_t)(chunkSize + overlap), size - offset);
        mach_vm_size_t read = 0;
        if (mach_vm_read_overwrite(task, address + offset, amount, (mach_vm_address_t)bytes, &read) == KERN_SUCCESS && read) { parse(bytes, (size_t)read, task); scanned += read; }
        else scanned += amount;
        offset += MIN((uint64_t)chunkSize, size - offset);
      }
      if ((scanned / (64 * 1024 * 1024)) % 4 == 0) output(@{ @"type": @"progress", @"bytes": @(scanned) });
    }
    if (UINT64_MAX - address < size) break;
    address += size;
  }
  if (seen.count >= 512 || scanned >= maxBytes || now() - started >= 60) limited = YES;
  memset(bytes, 0, chunkSize + overlap); free(bytes);
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    salts = [NSMutableSet set]; seen = [NSMutableSet set]; started = now();
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
      testMode = YES;
      NSString *key = @"18396da7a223436d43c560e3cc62d57cf12ba129b1df5e179133506462d843f1";
      NSString *salt = @"1234567890abcdef1234567890abcdef"; [salts addObject:salt];
      NSString *text = [NSString stringWithFormat:@"x'%@%@'", key, salt];
      NSData *ascii = [text dataUsingEncoding:NSASCIIStringEncoding], *utf16 = [text dataUsingEncoding:NSUTF16LittleEndianStringEncoding];
      parse(ascii.bytes, ascii.length, mach_task_self()); parse(utf16.bytes, utf16.length, mach_task_self());
      BOOL success = seen.count == 1;
      output(@{ @"type": @"self-test", @"success": @(success), @"formats": @2 }); return success ? 0 : 1;
    }
    NSData *input = [[NSFileHandle standardInput] readDataToEndOfFile];
    if (input.length > 65536) return 2;
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    if (![request isKindOfClass:[NSDictionary class]] || ![request[@"salts"] isKindOfClass:[NSArray class]]) return 2;
    for (id item in request[@"salts"]) if ([item isKindOfClass:[NSString class]] && [item length] == 32 && [item rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF"] invertedSet]].location == NSNotFound) [salts addObject:[item lowercaseString]];
    if (!salts.count || salts.count > 160) return 2;
    int count = proc_listallpids(NULL, 0);
    if (count <= 0 || count > 100000) return 3;
    pid_t *pids = calloc((size_t)count + 64, sizeof(pid_t));
    if (!pids) return 3;
    int actual = proc_listallpids(pids, (count + 64) * sizeof(pid_t));
    if (actual > count + 64) actual = count + 64;
    int processes = 0; BOOL denied = NO;
    for (int i = 0; i < actual && processes < 6; i++) {
      struct proc_bsdinfo info; char name[128] = {0};
      if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != getuid()) continue;
      if (proc_name(pids[i], name, sizeof(name)) <= 0 || (strcmp(name, "WeChat") && strcmp(name, "Weixin"))) continue;
      processes++;
      mach_port_t task = MACH_PORT_NULL;
      if (task_for_pid(mach_task_self(), pids[i], &task) != KERN_SUCCESS) { denied = YES; continue; }
      scan(task); mach_port_deallocate(mach_task_self(), task);
      if (limited) break;
    }
    free(pids);
    output(@{ @"type": @"complete", @"processes": @(processes), @"candidates": @(seen.count), @"denied": @(denied), @"limited": @(limited) });
    return 0;
  }
}
